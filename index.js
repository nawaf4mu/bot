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
const BOT_NAME = 'NA'; 
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

mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ Connected to MongoDB')).catch(console.error);

// ==========================================
// HELPERS
// ==========================================
async function sendLog(guildId, embed) {
    embed.setFooter({ text: `Powered by ${BOT_NAME} Security System` }).setTimestamp();
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
    { name: 'setup', description: 'Initialize NA Honeypot and Security' },
    { 
        name: 'setlogs', 
        description: 'Set the logs channel for NA System', 
        options: [{ name: 'channel', description: 'Log channel', type: ApplicationCommandOptionType.Channel, required: true, channel_types: [ChannelType.GuildText] }] 
    },
    { 
        name: 'send-dm', 
        description: 'Send DM to a user via NA', 
        options: [{ name: 'user', description: 'User', type: ApplicationCommandOptionType.User, required: true }, { name: 'message', description: 'Msg', type: ApplicationCommandOptionType.String, required: true }] 
    },
    { 
        name: 'send-all', 
        description: 'Send DM to all members via NA', 
        options: [{ name: 'message', description: 'Msg', type: ApplicationCommandOptionType.String, required: true }] 
    },
];

const registerCommands = async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ Slash commands registered!');
    } catch (error) { console.error('❌ Reg Error:', error); }
};

// ==========================================
// 1. ROLE PERSISTENCE & ANTI-RAID
// ==========================================
let joinLog = [];
client.on('guildMemberAdd', async (member) => {
    const now = Date.now();
    joinLog.push(now);
    joinLog = joinLog.filter(t => now - t < 60000);
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
        await UserRole.findOneAndUpdate({ userId: member.id, guildId: member.guild.id }, { roles: member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.id) }, { upsert: true });
    } catch (err) { console.error(err); }
});

// ==========================================
// 2. ANTI-NSFW & HONEYPOT
// ==========================================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    const settings = await GuildSettings.findOne({ guildId: message.guild.id });

    const content = message.content.toLowerCase();
    if (NSFW_KEYWORDS.some(word => content.includes(word))) {
        try {
            await message.delete();
            await message.member.timeout(20 * 60 * 60 * 1000, 'NSFW Content');
            sendLog(message.guild.id, new EmbedBuilder().setTitle('🔞 NSFW Detected').setDescription(`User: ${message.author}\nAction: Timeout 20h`).setColor('Red'));
        } catch (err) {}
        return;
    }

    if (settings?.honeypotTextChannelId && message.channel.id === settings.honeypotTextChannelId) {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            try {
                await message.author.send(`⚠️ **You have been caught by ${BOT_NAME} Honeypot!**\nYour account was softbanned from ${message.guild.name}.`).catch(() => {});
                await message.delete().catch(() => {});
                await message.member.ban({ reason: `${BOT_NAME} Honeypot Trap` });
                await message.guild.members.unban(message.author.id, { reason: 'Softban' });
                await GuildSettings.findOneAndUpdate({ guildId: message.guild.id }, { $inc: { softbanCount: 1 } });
                sendLog(message.guild.id, new EmbedBuilder().setTitle('🎯 Honeypot Triggered').setDescription(`User ${message.author} fell into the ${BOT_NAME} trap.`).setColor('Orange'));
            } catch (err) { console.error(err); }
        }
        return;
    }
});

// ==========================================
// 3. ANTI-NUKE
// ==========================================
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
            await executor.ban({ reason: `${BOT_NAME} Anti-Nuke` });
            sendLog(channel.guild.id, new EmbedBuilder().setTitle('🚨 NUKE PREVENTED').setDescription(`User ${executor.tag} was banned by ${BOT_NAME}.`).setColor('DarkRed'));
        }
    } catch (err) { console.error(err); }
});

// ==========================================
// SLASH COMMAND HANDLING
// ==========================================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '❌ No permission.', ephemeral: true });

        if (interaction.commandName === 'setup') {
            try {
                const trapChannel = await interaction.guild.channels.create({ name: '💬-general-chat', type: ChannelType.GuildText, position: 0 });
                await GuildSettings.findOneAndUpdate({ guildId: interaction.guild.id }, { honeypotTextChannelId: trapChannel.id }, { upsert: true });

                const setupEmbed = new EmbedBuilder()
                    .setTitle('⚠️ SYSTEM WARNING')
                    .setDescription(`This channel ${trapChannel} is now a **Honeypot**. \n\nAny user who sends a message or an image here will be instantly **Softbanned**.`)
                    .setColor('Red').setFooter({ text: `Securely managed by ${BOT_NAME}` }).setTimestamp();

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('view_stats').setLabel(`Statistics 📊`).setStyle(ButtonStyle.Secondary)
                );

                await trapChannel.send({ embeds: [setupEmbed], components: [row] });
                await interaction.reply({ content: `✅ ${BOT_NAME} Setup complete!`, ephemeral: true });
            } catch (err) { interaction.reply({ content: '❌ Error.', ephemeral: true }); }
        }

        if (interaction.commandName === 'setlogs') {
            const channel = interaction.options.getChannel('channel');
            await GuildSettings.findOneAndUpdate({ guildId: interaction.guild.id }, { logsChannelId: channel.id }, { upsert: true });
            await interaction.reply({ content: `✅ ${BOT_NAME} Logs channel set to ${channel}`, ephemeral: true });
        }

        if (interaction.commandName === 'send-dm') {
            const user = interaction.options.getUser('user');
            const msg = interaction.options.getString('message');
            try {
                await user.send(msg); // إرسال الرسالة كما هي بدون أي إضافات
                await interaction.reply({ content: `✅ Message sent to ${user.tag}`, ephemeral: true });
            } catch (err) {
                await interaction.reply({ content: `❌ Could not send DM to ${user.tag}.`, ephemeral: true });
            }
        }

        if (interaction.commandName === 'send-all') {
            const msg = interaction.options.getString('message');
            const members = await interaction.guild.members.fetch();
            let success = 0, failed = 0;
            await interaction.reply({ content: `🚀 ${BOT_NAME} is sending messages to all members...`, ephemeral: true });
            for (const [id, member] of members) {
                if (member.user.bot) continue;
                try {
                    await member.send(msg); // إرسال الرسالة كما هي بدون أي إضافات
                    success++;
                    await new Promise(r => setTimeout(r, 1500));
                } catch (e) { failed++; }
            }
            await interaction.followUp({ content: `✅ Finished!\nSent: ${success}\nFailed: ${failed}`, ephemeral: true });
        }
    } else if (interaction.isButton()) {
        if (interaction.customId === 'view_stats') {
            const settings = await GuildSettings.findOne({ guildId: interaction.guild.id });
            const count = settings ? settings.softbanCount : 0;
            const statsEmbed = new EmbedBuilder().setTitle(`📊 ${BOT_NAME} Honeypot Stats`).setDescription(`Total caught: **${count}**`).setColor('Blue').setFooter({ text: `Powered by ${BOT_NAME}` });
            await interaction.reply({ embeds: [statsEmbed], ephemeral: true });
        }
    }
});

client.on('ready', async () => {
    console.log(`🚀 ${BOT_NAME} Security Bot Online as ${client.user.tag}`);
    client.user.setActivity(`🛡️ ${BOT_NAME} Security`, { type: 3 }); 
    await registerCommands();
});

client.login(process.env.TOKEN);
