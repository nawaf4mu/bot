const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType, AuditLogEvent, REST, Routes, ApplicationCommandOptionType } = require('discord.js');
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
const ROLES_TO_REMOVE = ['1396230071886549134']; 
const NSFW_KEYWORDS = ['nsfw', 'porn', 'sex', 'إباحي', 'جنسي']; 
const RAID_THRESHOLD = 5; 
const NUKE_THRESHOLD = 3; 

// ==========================================
// DATABASE MODELS
// ==========================================
const userSchema = new mongoose.Schema({ userId: String, guildId: String, roles: [String] });
const UserRole = mongoose.model('UserRole', userSchema);

const guildSchema = new mongoose.Schema({
    guildId: String,
    honeypotTextChannelId: String, 
    logsChannelId: String, 
    softbanCount: { type: Number, default: 0 }
});
const GuildSettings = mongoose.model('GuildSettings', guildSchema);

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// ==========================================
// HELPERS
// ==========================================
async function sendLog(guildId, embed) {
    const settings = await GuildSettings.findOne({ guildId });
    if (settings && settings.logsChannelId) {
        const channel = await client.channels.fetch(settings.logsChannelId).catch(() => null);
        if (channel) channel.send({ embeds: [embed] }).catch(console.error);
    }
}

// ==========================================
// SLASH COMMANDS REGISTRATION
// ==========================================
const commands = [
    {
        name: 'setup',
        description: 'Initialize Honeypot and Security Systems',
    },
    {
        name: 'setlogs',
        description: 'Set the logs channel for the security system',
        options: [
            {
                name: 'channel',
                description: 'The channel for logs',
                type: ApplicationCommandOptionType.Channel,
                required: true,
                channel_types: [ChannelType.GuildText],
            },
        ],
    },
];

const registerCommands = async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        console.log('Registering slash commands...');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );
        console.log('✅ Slash commands registered successfully!');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
};

// ==========================================
// SECURITY SYSTEMS
// ==========================================

// 1. Role Restore & Anti-Raid
let joinLog = [];
client.on('guildMemberAdd', async (member) => {
    const now = Date.now();
    joinLog.push(now);
    joinLog = joinLog.filter(timestamp => now - timestamp < 60000);
    if (joinLog.length > RAID_THRESHOLD) console.log(`🚨 RAID DETECTED in ${member.guild.name}!`);

    try {
        const savedData = await UserRole.findOne({ userId: member.id, guildId: member.guild.id });
        if (savedData && savedData.roles.length > 0) {
            setTimeout(async () => {
                if (!member.guild) return;
                await member.roles.add(savedData.roles);
                const rolesToRemove = member.roles.cache.filter(role => ROLES_TO_REMOVE.includes(role.id));
                if (rolesToRemove.size > 0) await member.roles.remove(rolesToRemove);
            }, 10000);
        }
    } catch (err) { console.error(err); }
});

client.on('guildMemberRemove', async (member) => {
    try {
        await UserRole.findOneAndUpdate(
            { userId: member.id, guildId: member.guild.id },
            { roles: member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id) },
            { upsert: true }
        );
    } catch (err) { console.error(err); }
});

// 2. Anti-NSFW & Honeypot
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    const settings = await GuildSettings.findOne({ guildId: message.guild.id });

    const content = message.content.toLowerCase();
    if (NSFW_KEYWORDS.some(word => content.includes(word))) {
        try {
            await message.delete();
            await message.member.timeout(20 * 60 * 60 * 1000, 'NSFW Content');
            const logEmbed = new EmbedBuilder().setTitle('🔞 NSFW Detected').setDescription(`User: ${message.author}\nChannel: ${message.channel}\nAction: Timeout 20h`).setColor('Red');
            sendLog(message.guild.id, logEmbed);
        } catch (err) { console.error(err); }
        return;
    }

    if (settings && settings.honeypotTextChannelId && message.channel.id === settings.honeypotTextChannelId) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            try {
                await message.delete().catch(() => {});
                await message.member.ban({ reason: 'Honeypot Trap' });
                await message.guild.members.unban(message.author.id, { reason: 'Softban' });
                await GuildSettings.findOneAndUpdate({ guildId: message.guild.id }, { $inc: { softbanCount: 1 } });
                const logEmbed = new EmbedBuilder().setTitle('🎯 Honeypot Triggered').setDescription(`User ${message.author} fell into the trap and was softbanned.`).setColor('Orange');
                sendLog(message.guild.id, logEmbed);
            } catch (err) { console.error(err); }
        }
        return;
    }
});

// 3. Anti-Nuke
const channelCreationLog = new Map();
client.on('channelCreate', async (channel) => {
    try {
        const auditLogs = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelCreate });
        const entry = auditLogs.entries.first();
        if (!entry) return;
