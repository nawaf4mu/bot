const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==========================================
// CONFIGURATION
// ==========================================
// ضع هنا آيدي رتبة التوثيق أو أي رتبة تريد حذفها من الجميع عند الدخول
const ROLES_TO_REMOVE = ['1396230071886549134']; 

// ==========================================
// DATABASE MODELS
// ==========================================
const userSchema = new mongoose.Schema({
    userId: String,
    guildId: String,
    roles: [String]
});
const UserRole = mongoose.model('UserRole', userSchema);

const guildSchema = new mongoose.Schema({
    guildId: String,
    honeypotTextChannelId: String, 
    softbanCount: { type: Number, default: 0 }
});
const GuildSettings = mongoose.model('GuildSettings', guildSchema);

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

client.on('ready', () => {
    console.log(`🚀 Bot online as ${client.user.tag}`);
});

// ==========================================
// ROLE PERSISTENCE & CLEANING
// ==========================================

// Save roles when a member leaves
client.on('guildMemberRemove', async (member) => {
    try {
        await UserRole.findOneAndUpdate(
            { userId: member.id, guildId: member.guild.id },
            { roles: member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id) },
            { upsert: true }
        );
    } catch (err) { console.error(err); }
});

// Restore roles and Clean unwanted roles (For New and Old members)
client.on('guildMemberAdd', async (member) => {
    try {
        const savedData = await UserRole.findOne({ userId: member.id, guildId: member.guild.id });
        
        // Delay to let verification bots finish their work
        setTimeout(async () => {
            try {
                if (!member.guild) return;

                // 1. Restore old roles if they exist (For Old Members)
                if (savedData && savedData.roles.length > 0) {
                    await member.roles.add(savedData.roles);
                    console.log(`Restored roles for ${member.user.tag}`);
                }

                // 2. Remove blacklist roles (For Everyone: New and Old)
                const rolesToRemove = member.roles.cache.filter(role => ROLES_TO_REMOVE.includes(role.id));
                if (rolesToRemove.size > 0) {
                    await member.roles.remove(rolesToRemove);
                    console.log(`Cleaned unwanted roles from ${member.user.tag}`);
                }

            } catch (err) {
                console.error(`Error processing roles for ${member.user.tag}:`, err);
            }
        }, 10000); // 10 seconds delay
        
    } catch (err) {
        console.error(`Database error for ${member.user.tag}:`, err);
    }
});

// ==========================================
// HONEYPOT LOGIC (Text Trap + Auto Delete)
// ==========================================

client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const settings = await GuildSettings.findOne({ guildId: message.guild.id });
    
    // TEXT TRAP: Triggered when any message is sent in the honeypot channel
    if (settings && settings.honeypotTextChannelId && message.channel.id === settings.honeypotTextChannelId) {
        
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            try {
                // 1. Delete the message immediately
                await message.delete().catch(() => {});

                // 2. Softban the user
                await message.member.ban({ reason: 'Honeypot Text Trap' });
                await message.guild.members.unban(message.author.id, { reason: 'Softban' });

                // 3. Update stats
                await GuildSettings.findOneAndUpdate({ guildId: message.guild.id }, { $inc: { softbanCount: 1 } });
                
                console.log(`🎯 Softbanned ${message.author.tag} and cleaned message.`);
            } catch (err) { console.error(err); }
        }
        return;
    }

    // !setup Command
    if (message.content === '!setup') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        try {
            const trapChannel = await message.guild.channels.create({
                name: '💬-general-chat',
                type: ChannelType.GuildText,
                position: 0,
            });

            await GuildSettings.findOneAndUpdate(
                { guildId: message.guild.id },
                { honeypotTextChannelId: trapChannel.id },
                { upsert: true }
            );

            const setupEmbed = new EmbedBuilder()
                .setTitle('⚠️ SYSTEM WARNING')
                .setDescription(`This channel ${trapChannel} is now a **Honeypot**. \n\nAny user who sends a message or an image here will be instantly **Softbanned**.`)
                .setColor('Red')
                .setFooter({ text: 'NA' })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('view_stats')
                    .setLabel('Honeypot Statistics 📊')
                    .setStyle(ButtonStyle.Secondary)
            );

            await trapChannel.send({ embeds: [setupEmbed], components: [row] });
            await message.reply(`✅ Setup complete! Trap channel created: ${trapChannel}`);

        } catch (err) {
            console.error(err);
            message.reply('❌ Error during setup.');
        }
    }
});

// ==========================================
// BUTTON INTERACTIONS (Ephemeral Stats)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'view_stats') {
        const settings = await GuildSettings.findOne({ guildId: interaction.guild.id });
        const count = settings ? settings.softbanCount : 0;

        const statsEmbed = new EmbedBuilder()
            .setTitle('📊 Honeypot Stats')
            .setDescription(`Total users caught in the text trap: **${count}**`)
            .setColor('Blue')
            .setTimestamp();

        await interaction.reply({ 
            embeds: [statsEmbed], 
            ephemeral: true 
        });
    }
});

client.login(process.env.TOKEN);
