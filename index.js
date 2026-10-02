const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType, AuditLogEvent, REST, Routes, ApplicationCommandOptionType } = require('discord.js');
const mongoose = require('mongoose');
require('dotenv').config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates]
});

const ROLES_TO_REMOVE = ['1396230071886549134']; 
const NSFW_KEYWORDS = ['nsfw', 'porn', 'sex', 'إباحي', 'جنسي']; 
const RAID_THRESHOLD = 5; 
const NUKE_THRESHOLD = 3; 

const userSchema = new mongoose.Schema({ userId: String, guildId: String, roles: [String] });
const UserRole = mongoose.model('UserRole', userSchema);
const guildSchema = new mongoose.Schema({ guildId: String, honeypotTextChannelId: String, logsChannelId: String, softbanCount: { type: Number, default: 0 } });
const GuildSettings = mongoose.model('GuildSettings', guildSchema);

mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ MongoDB Connected')).catch(console.error);

async function sendLog(guildId, embed) {
    const settings = await GuildSettings.findOne({ guildId });
    if (settings && settings.logsChannelId) {
        const channel = await client.channels.fetch(settings.logsChannelId).catch(() => null);
        if (channel) channel.send({ embeds: [embed] }).catch(console.error);
    }
}

const commands = [
    { name: 'setup', description: 'Initialize Honeypot and Security' },
    { name: 'setlogs', description: 'Set logs channel', options: [{ name: 'channel', description: 'Channel', type: ApplicationCommandOptionType.Channel, required: true, channel_types: [ChannelType.GuildText] }] }
];

const registerCommands = async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Commands Registered');
    } catch (e) { console.error('❌ Reg Error:', e); }
};

let joinLog = [];
client.on('guildMemberAdd', async (member) => {
    const now = Date.now();
    joinLog.push(now);
    joinLog = joinLog.filter(t => now - t < 60000);
    if (joinLog.length > RAID_THRESHOLD) console.log('🚨 RAID DETECTED!');
    try {
        const saved = await UserRole.findOne({ userId: member.id, guildId: member.guild.id });
        if (saved && saved.roles.length > 0) {
            setTimeout(async () => {
                if (!member.guild) return;
                await member.roles.add(saved.roles);
                const toRem = member.roles.cache.filter(r => ROLES_TO_REMOVE.includes(r.id));
                if (toRem.size > 0) await member.roles.remove(toRem);
            }, 10000);
        }
    } catch (e) {}
});

client.on('guildMemberRemove', async (member) => {
    try {
        await UserRole.findOneAndUpdate({ userId: member.id, guildId: member.guild.id }, { roles: member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id) }, { upsert: true });
    } catch (e) {}
});

client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    const settings = await GuildSettings.findOne({ guildId: message.guild.id });
    const content = message.content.toLowerCase();
    if (NSFW_KEYWORDS.some(w => content.includes(w))) {
        try {
            await message.delete();
            await message.member.timeout(20 * 60 * 60 * 1000, 'NSFW');
            sendLog(message.guild.id, new EmbedBuilder().setTitle('🔞 NSFW').setDescription(`User: ${message.author}\nAction: Timeout 20h`).setColor('Red'));
        } catch (e) {}
        return;
    }
    if (settings?.honeypotTextChannelId && message.channel.id === settings.honeypotTextChannelId) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            try {
                await message.delete().catch(() => {});
                await message.member.ban({ reason: 'Honeypot' });
                await message.guild.members.unban(message.author.id, { reason: 'Softban' });
                await GuildSettings.findOneAndUpdate({ guildId: message.guild.id }, { $inc: { softbanCount: 1 } });
                sendLog(message.guild.id, new EmbedBuilder().setTitle('🎯 Honeypot').setDescription(`User ${message.author} softbanned.`).setColor('Orange'));
            } catch (e) {}
        }
        return;
    }
});

const nukeLog = new Map();
client.on('channelCreate', async (channel) => {
    try {
        const logs = await channel.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.ChannelCreate });
        const entry = logs.entries.first();
        if (!entry || entry.executor.id === client.user.id) return;
        const exec = entry.executor;
        const now = Date.now();
        const uLog = (nukeLog.get(exec.id) || []).filter(t => now - t < 10000);
        uLog.push(now);
        nukeLog.set(exec.id, uLog);
        if (uLog.length > NUKE_THRESHOLD) {
            await exec.set('roles', []);
            await exec.ban({ reason: 'Nuke' });
            sendLog(channel.guild.id, new EmbedBuilder().setTitle('🚨 NUKE PREVENTED').setDescription(`User ${exec.tag} banned.`).setColor('DarkRed'));
        }
    } catch (e) {}
});

client.on('interactionCreate', async (int) => {
    if (int.isChatInputCommand()) {
        if (!int.member.permissions.has(PermissionsBitField.Flags.Administrator)) return int.reply({ content: '❌ No perm.', ephemeral: true });
        if (int.commandName === 'setup') {
            try {
                const ch = await int.guild.channels.create({ name: '💬-general-chat', type: ChannelType.GuildText, position: 0 });
                await GuildSettings.findOneAndUpdate({ guildId: int.guild.id }, { honeypotTextChannelId: ch.id }, { upsert: true });
                const emb = new EmbedBuilder().setTitle('⚠️ SECURITY ACTIVE').setDescription(`Honeypot: ${ch}\nAnti-NSFW & Nuke: **ON**`).setColor('Red');
                const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('view_stats').setLabel('Stats 📊').setStyle(ButtonStyle.Secondary));
                await ch.send({ embeds: [emb], components: [row] });
                int.reply({ content: '✅ Setup Done!', ephemeral: true });
            } catch (e) { int.reply({ content: '❌ Error', ephemeral: true }); }
        }
        if (int.commandName === 'setlogs') {
            const ch = int.options.getChannel('channel');
            await GuildSettings.findOneAndUpdate({ guildId: int.guild.id }, { logsChannelId: ch.id }, { upsert: true });
            int.reply({ content: `✅ Logs set to ${ch}`, ephemeral: true });
        }
    } else if (int.isButton() && int.customId === 'view_stats') {
        const s = await GuildSettings.findOne({ guildId: int.guild.id });
        int.reply({ embeds: [new EmbedBuilder().setTitle('📊 Stats').setDescription(`Caught: **${s?.softbanCount || 0}**`).setColor('Blue')], ephemeral: true });
    }
});

client.on('ready', async () => {
    console.log(`🚀 Online: ${client.user.tag}`);
    await registerCommands();
});

client.login(process.env.TOKEN);
