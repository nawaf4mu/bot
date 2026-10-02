const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType, AuditLogEvent, REST, Routes } = require('discord.js');
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
// CONFIGURATION
// ==========================================
const NSFW_KEYWORDS = ['nsfw', 'porn', 'sex', 'إباحي', 'جنسي']; 
const RAID_THRESHOLD = 5; 
const NUKE_THRESHOLD = 3; 

// ==========================================
// DATABASE MODELS
// ==========================================
const guildSchema = new mongoose.Schema({
    guildId: String,
    honeypotTextChannelId: String, 
    softbanCount: { type: Number, default: 0 }
});
const GuildSettings = mongoose.model('GuildSettings', guildSchema);

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// ==========================================
// SLASH COMMANDS REGISTRATION
// ==========================================
const commands = [
    {
        name: 'setup',
        description: 'Initialize Honeypot and Security Systems',
    },
];

const registerCommands = async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID), // تحتاج إضافة CLIENT_ID في المتغيرات
            { body: commands },
        );
        console.log('Successfully registered application commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
};

// ==========================================
// SECURITY SYSTEMS
// ==========================================

// 1. Anti-Raid (Join Monitoring)
let joinLog = [];
client.on('guildMemberAdd', async (member) => {
    const now = Date.now();
    joinLog.push(now);
    joinLog = joinLog.filter(timestamp => now - timestamp < 60000);
    if (joinLog.length > RAID_THRESHOLD) {
        console.log(`🚨 RAID DETECTED in ${member.guild.name}!`);
    }
});

// 2. Anti-NSFW & Honeypot Logic
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const settings = await GuildSettings.findOne({ guildId: message.guild.id });

    // Anti-NSFW
    const content = message.content.toLowerCase();
    if (NSFW_KEYWORDS.some(word => content.includes(word))) {
        try {
            await message.delete();
            await message.member.timeout(20 * 60 * 60 * 1000, 'NSFW Content');
            const warnEmbed = new EmbedBuilder().setTitle('🔞 NSFW Warning').setDescription(`User ${message.author} has been timed out for 20h.`).setColor('Red');
            message.channel.send({ embeds: [warnEmbed] });
        } catch (err) { console.error('NSFW Error:', err); }
        return;
    }

    // Honeypot Trap
    if (settings && settings.honeypotTextChannelId && message.channel.id === settings.honeypotTextChannelId) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            try {
                await message.delete().catch(() => {});
                await message.member.ban({ reason: 'Honeypot Trap' });
                await message.guild.members.unban(message.author.id, { reason: 'Softban' });
                await GuildSettings.findOneAndUpdate({ guildId: message.guild.id }, { $inc: { softbanCount: 1 } });
            } catch (err) { console.error(err); }
        }
        return;
    }
});

// 3. Anti-Nuke (Channel Protection)
const channelCreationLog = new Map();
client.on('channelCreate', async (channel) => {
    try {
        const auditLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelCreate });
        const entry = auditLogs.entries.first();
        if (!entry) return;
        const { executor } = entry;
        if (executor.id === client.user.id) return;

        const now = Date.now();
        const userLog = channelCreationLog.get(executor.id) || [];
        userLog.push(now);
        const recentCreations = userLog.filter(t => now - t < 10000);
        channelCreationLog.set(executor.id, recentCreations);

        if (recentCreations.length > NUKE_THRESHOLD) {
            await executor.set('roles', []); 
            await executor.ban({ reason: 'Server Nuking' });
        }
    } catch (err) { console.error('Anti-Nuke Error:', err); }
});

// ==========================================
// SLASH COMMAND HANDLING
// ==========================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'setup') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: '❌ Only Admins can use this.', ephemeral: true });
        }

        try {
            const trapChannel = await interaction.guild.channels.create({
                name: '💬-general-chat',
                type: ChannelType.GuildText,
                position: 0,
            });

            await GuildSettings.findOneAndUpdate(
                { guildId: interaction.guild.id },
                { honeypotTextChannelId: trapChannel.id },
                { upsert: true }
            );

            const setupEmbed = new EmbedBuilder()
                .setTitle('⚠️ SECURITY SYSTEM ACTIVE')
                .setDescription(`Honeypot: ${trapChannel}\nAnti-NSFW & Anti-Nuke: **ENABLED**`)
                .setColor('Red').setFooter({ text: 'NA' }).setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('view_stats').setLabel('Honeypot Stats 📊').setStyle(ButtonStyle.Secondary)
            );

            await trapChannel.send({ embeds: [setupEmbed], components: [row] });
            await interaction.reply({ content: `✅ Setup complete! Trap created: ${trapChannel}`, ephemeral: true });
        } catch (err) {
            console.error(err);
            interaction.reply({ content: '❌ Error during setup.', ephemeral: true });
        }
    }
});

// Handle Statistics Button
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId === 'view_stats') {
        const settings = await GuildSettings.findOne({ guildId: interaction.guild.id });
        const count = settings ? settings.softbanCount : 0;
        const statsEmbed = new EmbedBuilder().setTitle('📊 Honeypot Stats').setDescription(`Total caught: **${count}**`).setColor('Blue');
        await interaction.reply({ embeds: [statsEmbed], ephemeral: true });
    }
});

client.on('ready', async () => {
    console.log(`🚀 Security Bot Online as ${client.user.tag}`);
    await registerCommands();
});

client.login(process.env.TOKEN);
