const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ==========================================
// DATABASE MODELS (MongoDB)
// ==========================================
const userSchema = new mongoose.Schema({
    userId: String,
    guildId: String,
    roles: [String]
});
const UserRole = mongoose.model('UserRole', userSchema);

const guildSchema = new mongoose.Schema({
    guildId: String,
    honeypotChannelId: String, 
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
// HONEYPOT LOGIC (Voice & Text)
// ==========================================

// 1. Voice Trap
client.on('voiceStateUpdate', async (oldState, newState) => {
    const settings = await GuildSettings.findOne({ guildId: newState.guild.id });
    if (!settings || !settings.honeypotChannelId) return;

    if (newState.channelId === settings.honeypotChannelId && oldState.channelId !== newState.channelId) {
        const member = newState.member;
        if (!member || !member.bannable) return;

        try {
            await member.ban({ reason: 'Honeypot Voice' });
            await newState.guild.members.unban(member.id, { reason: 'Softban' });
            await GuildSettings.findOneAndUpdate({ guildId: newState.guild.id }, { $inc: { softbanCount: 1 } });
        } catch (err) { console.error(err); }
    }
});

// 2. Text Trap & Setup Command
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const settings = await GuildSettings.findOne({ guildId: message.guild.id });
    
    // Text Trap: Softban if user types in the security channel
    if (settings && settings.honeypotTextChannelId && message.channel.id === settings.honeypotTextChannelId) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            try {
                await message.member.ban({ reason: 'Honeypot Text' });
                await message.guild.members.unban(message.author.id, { reason: 'Softban' });
                await GuildSettings.findOneAndUpdate({ guildId: message.guild.id }, { $inc: { softbanCount: 1 } });
            } catch (err) { console.error(err); }
        }
        return;
    }

    // !setup #voice-channel
    if (message.content.startsWith('!setup')) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const channelMention = message.mentions.channels.first();
        if (!channelMention || channelMention.type !== ChannelType.GuildVoice) {
            return message.reply('❌ Please mention a **Voice Channel**. Example: `!setup #voice-room`');
        }

        try {
            const textChannel = await message.guild.channels.create({
                name: '🛡️-security-center',
                type: ChannelType.GuildText,
                position: 0,
            });

            await GuildSettings.findOneAndUpdate(
                { guildId: message.guild.id },
                { 
                    honeypotChannelId: channelMention.id, 
                    honeypotTextChannelId: textChannel.id 
                },
                { upsert: true }
            );

            const setupEmbed = new EmbedBuilder()
                .setTitle('⚠️ SYSTEM WARNING')
                .setDescription('**DO NOT TYPE IN THIS CHANNEL!**\n\nAny user who sends a message here or joins the voice channel <#' + channelMention.id + '> will be instantly **Softbanned** from the server.\n\n*This is an automated security measure.*')
                .setColor('Red')
                .setThumbnail(message.guild.iconURL())
                .setFooter({ text: 'NA' })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('view_stats')
                    .setLabel('Honeypot Statistics 📊')
                    .setStyle(ButtonStyle.Secondary)
            );

            await textChannel.send({ embeds: [setupEmbed], components: [row] });
            await message.reply(`✅ Setup complete! The security channel has been created at the top: ${textChannel}`);

        } catch (err) {
            console.error(err);
            message.reply('❌ Error during setup.');
        }
    }
});

// ==========================================
// BUTTON INTERACTIONS (Hidden Stats)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'view_stats') {
        const settings = await GuildSettings.findOne({ guildId: interaction.guild.id });
        const count = settings ? settings.softbanCount : 0;

        const statsEmbed = new EmbedBuilder()
            .setTitle('📊 Honeypot Stats')
            .setDescription(`Total users caught in the trap: **${count}**`)
            .setColor('Blue')
            .setTimestamp();

        await interaction.reply({ 
            embeds: [statsEmbed], 
            ephemeral: true 
        });
    }
});

client.login(process.env.TOKEN);
