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
// ROLE PERSISTENCE (Restore Roles)
// ==========================================
client.on('guildMemberRemove', async (member) => {
    try {
        await UserRole.findOneAndUpdate(
            { userId: member.id, guildId: member.guild.id },
            { roles: member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id) },
            { upsert: true }
        );
    } catch (err) { console.error(err); }
});

client.on('guildMemberAdd', async (member) => {
    try {
        const savedData = await UserRole.findOne({ userId: member.id, guildId: member.guild.id });
        if (savedData && savedData.roles.length > 0) {
            await member.roles.add(savedData.roles);
        }
    } catch (err) { console.error(err); }
});

// ==========================================
// HONEYPOT LOGIC (Text-Only Trap)
// ==========================================

client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const settings = await GuildSettings.findOne({ guildId: message.guild.id });
    
    // TEXT TRAP: If user sends any message (Text, Image, File) in the honeypot channel
    if (settings && settings.honeypotTextChannelId && message.channel.id === settings.honeypotTextChannelId) {
        // Ignore administrators so they can manage the channel
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            try {
                await message.member.ban({ reason: 'Honeypot Text Trap' });
                await message.guild.members.unban(message.author.id, { reason: 'Softban' });
                await GuildSettings.findOneAndUpdate({ guildId: message.guild.id }, { $inc: { softbanCount: 1 } });
                console.log(`🎯 Softbanned ${message.author.tag} for messaging in the trap.`);
            } catch (err) { console.error(err); }
        }
        return;
    }

    // !setup Command (Creates the Trap Chat)
    if (message.content === '!setup') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        try {
            // Create a normal text channel that looks like a chat
            const trapChannel = await message.guild.channels.create({
                name: '💬-general-chat', // Name it something normal to lure people
                type: ChannelType.GuildText,
                position: 0, // Put it at the top
            });

            await GuildSettings.findOneAndUpdate(
                { guildId: message.guild.id },
                { honeypotTextChannelId: trapChannel.id },
                { upsert: true }
            );

            // Embed to inform admins or set as a hidden warning
            const setupEmbed = new EmbedBuilder()
                .setTitle('⚠️ SECURITY SYSTEM ACTIVE')
                .setDescription(`This channel ${trapChannel} is now a **Honeypot**. \n\nAnyone who sends a message or an image here will be instantly **Softbanned**.`)
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
// BUTTON INTERACTIONS
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
