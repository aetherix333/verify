require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    Events, 
    REST, 
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    AttachmentBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const dbFile = './users.json';
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({}));
}

function saveUserTokens(userId, accessToken, refreshToken, expiresIn) {
    const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    data[userId] = {
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresAt: Date.now() + (expiresIn * 1000)
    };
    fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));
}

function getAllUsers() {
    return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
}

function cleanupExpiredTokens() {
    try {
        const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
        const now = Date.now();
        let cleaned = false;
        let expiredCount = 0;
        
        for (const [userId, userData] of Object.entries(data)) {
            const isExpired = userData.expiresAt < now;
            const hasRefreshToken = !!userData.refreshToken;
            
            if (isExpired && !hasRefreshToken) {
                delete data[userId];
                cleaned = true;
                expiredCount++;
                console.log(`🗑️ ลบข้อมูลของ User ID: ${userId} (Token หมดอายุและไม่มี Refresh Token)`);
            }
            else if (isExpired && hasRefreshToken && (now - userData.expiresAt > 7 * 24 * 60 * 60 * 1000)) {
                delete data[userId];
                cleaned = true;
                expiredCount++;
                console.log(`🗑️ ลบข้อมูลของ User ID: ${userId} (Refresh Token หมดอายุแล้ว)`);
            }
        }
        
        if (cleaned) {
            fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));
            console.log(`✅ ทำความสะอาดข้อมูลสำเร็จ: ลบ ${expiredCount} รายการ`);
        }
        
        return expiredCount;
    } catch (error) {
        console.error('❌ เกิดข้อผิดพลาดในการทำความสะอาดข้อมูล:', error.message);
        return 0;
    }
}

async function refreshAccessToken(userId, refreshToken) {
    try {
        const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
        const userData = data[userId];
        
        if (userData && Date.now() - userData.expiresAt > 7 * 24 * 60 * 60 * 1000) {
            console.log(`⚠️ Refresh Token ของ ${userId} หมดอายุแล้ว (เกิน 7 วัน)`);
            delete data[userId];
            fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));
            return null;
        }
        
        const response = await axios.post('https://discord.com/api/oauth2/token', 
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            }).toString(),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        );

        const newAccessToken = response.data.access_token;
        const newRefreshToken = response.data.refresh_token || refreshToken;
        const expiresIn = response.data.expires_in;

        const data2 = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
        data2[userId] = {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresAt: Date.now() + (expiresIn * 1000)
        };
        fs.writeFileSync(dbFile, JSON.stringify(data2, null, 4));

        return newAccessToken;
    } catch (error) {
        console.error(`Refresh Token ล้มเหลวสำหรับ ${userId}:`, error.message);
        if (error.response && error.response.status === 400) {
            const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
            if (data[userId]) {
                delete data[userId];
                fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));
                console.log(`🗑️ ลบข้อมูลของ User ID: ${userId} (Refresh Token ใช้ไม่ได้แล้ว)`);
            }
        }
        return null;
    }
}

async function getValidAccessToken(userId) {
    const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const userData = data[userId];
    
    if (!userData) return null;
    
    if (userData.expiresAt < Date.now() - 7 * 24 * 60 * 60 * 1000) {
        console.log(`🗑️ Token ของ ${userId} หมดอายุเกิน 7 วันแล้ว`);
        delete data[userId];
        fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));
        return null;
    }
    
    if (userData.expiresAt && userData.expiresAt > Date.now()) {
        return userData.accessToken;
    }
    
    if (userData.refreshToken) {
        console.log(`กำลัง Refresh Token สำหรับ ${userId}...`);
        const newToken = await refreshAccessToken(userId, userData.refreshToken);
        return newToken;
    }
    
    delete data[userId];
    fs.writeFileSync(dbFile, JSON.stringify(data, null, 4));
    return null;
}

async function refreshAllTokens() {
    const data = getAllUsers();
    const userIds = Object.keys(data);
    let successCount = 0;
    let failCount = 0;
    
    console.log(`🔄 เริ่ม Refresh Token ทั้งหมด ${userIds.length} คน...`);
    
    for (const userId of userIds) {
        const token = await getValidAccessToken(userId);
        if (token) {
            successCount++;
        } else {
            failCount++;
        }
        await new Promise(res => setTimeout(res, 1000));
    }
    
    console.log(`✅ Refresh เสร็จสิ้น: สำเร็จ ${successCount} คน, ล้มเหลว ${failCount} คน`);
    return { successCount, failCount };
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const app = express();
const PORT = process.env.PORT || process.env.SERVER_PORT || 10398;

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send('ไม่พบ Code สำหรับยืนยันตัวตน');

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.REDIRECT_URI
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;
        const refreshToken = tokenResponse.data.refresh_token;
        const expiresIn = tokenResponse.data.expires_in;

        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${accessToken}` }
        });
        const user = userResponse.data;
        const userId = user.id;

        saveUserTokens(userId, accessToken, refreshToken, expiresIn);

        try {
            await axios.put(`https://discord.com/api/guilds/${process.env.GUILD_ID}/members/${userId}`, {
                access_token: accessToken
            }, {
                headers: { 
                    'Authorization': `Bot ${process.env.BOT_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
        } catch (e) {}

        try {
            const guild = await client.guilds.fetch(process.env.GUILD_ID);
            const member = await guild.members.fetch(userId);
            await member.roles.add(process.env.ROLE_ID);
            console.log(`[Success] ให้ยศคุณ ${user.username} สำเร็จ!`);
        } catch (err) {
            console.log(`[Error] ให้ยศ ${user.username} ไม่สำเร็จ สาเหตุ: ${err.message}`);
        }

        const avatarUrl = user.avatar 
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=512` 
            : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator || 0) % 5}.png`;

        const htmlPage = `
        <!DOCTYPE html>
        <html lang="th">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verify Success</title>
            <link href="https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Kanit', sans-serif; }
                body { 
                    background: #0a0000;
                    background-image: 
                        radial-gradient(ellipse at top left, rgba(255, 0, 0, 0.15) 0%, transparent 50%),
                        radial-gradient(ellipse at bottom right, rgba(255, 0, 0, 0.1) 0%, transparent 50%),
                        linear-gradient(135deg, #0a0000 0%, #1a0000 100%);
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    color: #fff;
                    position: relative;
                    overflow: hidden;
                }
                body::before {
                    content: '';
                    position: absolute;
                    top: -50%;
                    left: -50%;
                    width: 200%;
                    height: 200%;
                    background: radial-gradient(circle at center, rgba(255, 0, 0, 0.03) 0%, transparent 70%);
                    animation: rotate 20s linear infinite;
                }
                @keyframes rotate {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .card {
                    position: relative;
                    z-index: 2;
                    background: rgba(10, 0, 0, 0.9);
                    backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 0, 0, 0.3);
                    border-radius: 24px;
                    padding: 45px 40px;
                    width: 90%;
                    max-width: 450px;
                    text-align: center;
                    box-shadow: 
                        0 0 60px rgba(255, 0, 0, 0.1),
                        inset 0 1px 0 rgba(255, 0, 0, 0.2);
                    animation: fadeIn 0.8s ease-out;
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(30px) scale(0.95); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                .logo-circle {
                    width: 90px;
                    height: 90px;
                    border-radius: 50%;
                    border: 3px solid #ff0000;
                    margin: 0 auto 20px;
                    overflow: hidden;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    background: #000;
                    box-shadow: 0 0 40px rgba(255, 0, 0, 0.3);
                    transition: all 0.3s ease;
                }
                .logo-circle:hover {
                    box-shadow: 0 0 60px rgba(255, 0, 0, 0.5);
                    transform: scale(1.05);
                }
                .logo-circle img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }
                .badge {
                    display: inline-block;
                    background: rgba(255, 0, 0, 0.2);
                    border: 1px solid rgba(255, 0, 0, 0.3);
                    padding: 5px 20px;
                    border-radius: 20px;
                    font-size: 0.7rem;
                    letter-spacing: 3px;
                    text-transform: uppercase;
                    color: #ff4444;
                    margin-bottom: 10px;
                    font-weight: 500;
                }
                h1 {
                    font-size: 2.4rem;
                    font-weight: 700;
                    margin-bottom: 5px;
                    background: linear-gradient(135deg, #ff0000, #cc0000);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    text-shadow: none;
                }
                .subtitle {
                    font-size: 1rem;
                    color: #888;
                    margin-bottom: 30px;
                    font-weight: 300;
                }
                .profile-box {
                    background: rgba(0, 0, 0, 0.6);
                    border: 1px solid rgba(255, 0, 0, 0.2);
                    border-radius: 16px;
                    padding: 15px;
                    display: flex;
                    align-items: center;
                    margin-bottom: 25px;
                    transition: all 0.3s ease;
                }
                .profile-box:hover {
                    border-color: rgba(255, 0, 0, 0.5);
                    box-shadow: 0 0 30px rgba(255, 0, 0, 0.05);
                }
                .avatar {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                    margin-right: 15px;
                    border: 2px solid #ff0000;
                    object-fit: cover;
                }
                .user-info {
                    text-align: left;
                }
                .username {
                    font-size: 1.2rem;
                    font-weight: 600;
                    color: #fff;
                }
                .role {
                    font-size: 0.8rem;
                    color: #ff4444;
                    font-weight: 300;
                }
                .desc {
                    font-size: 0.95rem;
                    color: #aaa;
                    margin-bottom: 25px;
                    line-height: 1.8;
                }
                .verified-badge {
                    display: block;
                    border: 1px solid rgba(255, 0, 0, 0.3);
                    color: #ff4444;
                    padding: 12px;
                    border-radius: 12px;
                    font-weight: 600;
                    margin-bottom: 20px;
                    background: rgba(255, 0, 0, 0.05);
                    font-size: 0.9rem;
                    letter-spacing: 1px;
                }
                .verified-badge::before {
                    content: '✓ ';
                    color: #ff0000;
                }
                .btn-discord {
                    display: block;
                    background: linear-gradient(135deg, #ff0000, #cc0000);
                    color: #fff;
                    text-decoration: none;
                    padding: 16px;
                    border-radius: 12px;
                    font-weight: 600;
                    font-size: 1.1rem;
                    transition: all 0.3s ease;
                    border: none;
                    cursor: pointer;
                    letter-spacing: 0.5px;
                }
                .btn-discord:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 40px rgba(255, 0, 0, 0.3);
                    background: linear-gradient(135deg, #ff1111, #dd0000);
                }
                .btn-discord:active {
                    transform: translateY(0);
                }
                .footer {
                    margin-top: 30px;
                    font-size: 0.8rem;
                    color: #333;
                }
                .footer span {
                    color: #ff0000;
                }
                @media (max-width: 480px) {
                    .card { padding: 30px 20px; }
                    h1 { font-size: 2rem; }
                    .logo-circle { width: 70px; height: 70px; }
                }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="logo-circle">
                    <img src="https://i.postimg.cc/BZgQX4YJ/quality-restoration-25690718230032322.png" alt="Logo">
                </div>
                
                <div class="badge">✦ Verified</div>
                <h1>ยืนยันตัวตนสำเร็จ</h1>
                <p class="subtitle">คุณได้เข้าสู่ระบบเรียบร้อยแล้ว</p>
                
                <div class="profile-box">
                    <img src="${avatarUrl}" alt="Avatar" class="avatar">
                    <div class="user-info">
                        <div class="username">${user.username}</div>
                        <div class="role">✦ Member Verified</div>
                    </div>
                </div>
                
                <p class="desc">ระบบได้ทำการยืนยันตัวตนของคุณเรียบร้อยแล้ว<br>ตอนนี้คุณสามารถกลับเข้าสู่ <span style="color:#ff0000;">Discord</span> ได้ทันที</p>
                <div class="verified-badge">Account Verified Successfully</div>
                <a href="discord://" class="btn-discord">🚀 กลับสู่ Discord</a>
                
                <div class="footer">
                    &copy; 2026 <span>✦</span> Server<br>
                    Powered by <span>zent</span>
                </div>
            </div>
        </body>
        </html>
        `;
        res.send(htmlPage);

    } catch (error) {
        console.error(error.response ? error.response.data : error.message);
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    background: #0a0000;
                    display: flex; 
                    justify-content: center; 
                    align-items: center; 
                    min-height: 100vh;
                    font-family: Arial, sans-serif;
                }
                .error-box {
                    background: rgba(10, 0, 0, 0.9);
                    border: 2px solid #ff0000;
                    border-radius: 20px;
                    padding: 50px;
                    text-align: center;
                    max-width: 500px;
                }
                .error-box h1 { color: #ff0000; font-size: 3rem; margin-bottom: 20px; }
                .error-box p { color: #888; font-size: 1.2rem; }
            </style>
        </head>
        <body>
            <div class="error-box">
                <h1>❌</h1>
                <p style="color:#ff0000; font-size:1.5rem;">เกิดข้อผิดพลาด</p>
                <p>ไม่สามารถยืนยันตัวตนได้<br>กรุณาลองใหม่อีกครั้ง</p>
            </div>
        </body>
        </html>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`[Web Server] รันสำเร็จที่ PORT: ${PORT}`);
});

const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('จัดการระบบยืนยันตัวตน (เฉพาะ Owner)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) 
        .addSubcommand(subcommand =>
            subcommand
                .setName('panel')
                .setDescription('ส่งหน้าต่าง Verify ไปยังห้องที่กำหนด')
                .addChannelOption(option => 
                    option.setName('channel')
                        .setDescription('ห้องที่ต้องการให้หน้าต่างปรากฏ')
                        .setRequired(true)
                )
        ),
    new SlashCommandBuilder()
        .setName('serex')
        .setDescription('เมนูจัดการระบบ Verify (เฉพาะ Owner)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('menu')
                .setDescription('แสดงเมนูจัดการระบบ Verify')
        ),
    new SlashCommandBuilder()
        .setName('list')
        .setDescription('เช็คจำนวนและรายชื่อไอดีในฐานข้อมูลทั้งหมด')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('check')
        .setDescription('เช็คจำนวนและรายชื่อคนที่เคย Verify')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('checktoken')
        .setDescription('เช็คสถานะ Token ของสมาชิก')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option =>
            option.setName('user')
                .setDescription('ผู้ใช้ที่ต้องการเช็ค')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('cleanup')
        .setDescription('ลบข้อมูล Token ที่หมดอายุทั้งหมด')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.once(Events.ClientReady, async readyClient => {
    console.log(`[Discord Bot] ออนไลน์แล้วในชื่อ ${readyClient.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('ลงทะเบียน Slash Commands สำเร็จแล้ว!');
    } catch (error) {
        console.error('ข้อผิดพลาดในการลงทะเบียนคำสั่ง:', error);
    }
    
    const cleaned = cleanupExpiredTokens();
    console.log(`🧹 ทำความสะอาดข้อมูลเริ่มต้น: ลบ ${cleaned} รายการ`);
    
    setInterval(() => {
        console.log('🔄 เริ่มทำความสะอาดข้อมูลอัตโนมัติ...');
        const cleaned = cleanupExpiredTokens();
        console.log(`🧹 ทำความสะอาดข้อมูล: ลบ ${cleaned} รายการ`);
    }, 24 * 60 * 60 * 1000);
    

    setInterval(async () => {
        console.log('🔄 เริ่ม Refresh Token อัตโนมัติ...');
        const result = await refreshAllTokens();
        console.log(`✅ Refresh อัตโนมัติ: สำเร็จ ${result.successCount} คน, ล้มเหลว ${result.failCount} คน`);
    }, 20 * 60 * 60 * 1000);
});

const delay = ms => new Promise(res => setTimeout(res, ms));

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
        const ownerId = process.env.OWNER_ID; 

        if (interaction.user.id !== ownerId) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⛔ Failed')
                .setDescription('คำสั่งนี้สงวนไว้สำหรับ **เจ้าของบอท** เท่านั้น!')
                .setFooter({ text: 'ระบบความปลอดภัย', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        const { commandName, options } = interaction;

        if (commandName === 'verify' && options.getSubcommand() === 'panel') {
            const targetChannel = options.getChannel('channel');
            const oauthUrl = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&scope=identify+guilds.join`;

            const verifyEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('SEREX VERIFY')
                .setDescription('**กดปุ่มด้านล่างเพื่อทำการยืนยันตัวตน**\n\nหลังจากกดปุ่มแล้วระบบจะนำคุณไปยังหน้าเว็บเพื่อยืนยันตัวตน')
                .setImage('https://i.postimg.cc/wTMHMJRJ/IMG-5810.png')
                .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            const button = new ButtonBuilder()
                .setLabel('✅ รับยศเพื่อเห็นห้อง')
                .setURL(oauthUrl)
                .setStyle(ButtonStyle.Link);

            const row = new ActionRowBuilder().addComponents(button);

            try {
                await targetChannel.send({ embeds: [verifyEmbed], components: [row] });
                
                const successEmbed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('✅ Success')
                    .setDescription(`ส่งหน้าต่าง Verify ไปที่ห้อง ${targetChannel} เรียบร้อยแล้ว`)
                    .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                
                await interaction.reply({ embeds: [successEmbed], ephemeral: true });
            } catch (error) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Failed')
                    .setDescription('ไม่สามารถส่งข้อความไปที่ห้องนั้นได้\nกรุณาตรวจสอบสิทธิ์ของบอท')
                    .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                
                await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
        }

        if (commandName === 'serex' && options.getSubcommand() === 'menu') {
            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('🛠️ Serex Menu - ระบบจัดการ Verify')
                .setDescription('เลือกการทำงานที่ต้องการด้านล่าง')
                .addFields(
                    { name: 'Add Member', value: 'ดึงสมาชิกที่เคยกด Verify เข้าเซิร์ฟเวอร์', inline: false },
                    { name: 'Check Member', value: 'ตรวจสอบว่าสมาชิกที่เคย Verify อยู่ในเซิร์ฟเวอร์กี่คน', inline: false },
                    { name: 'Refresh Token', value: 'รีเฟรช Token ของสมาชิกทุกคนในฐานข้อมูล', inline: false }
                )
                .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('serex_add')
                        .setLabel('Add Member')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('serex_check')
                        .setLabel('Check Member')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('serex_refresh')
                        .setLabel('Refresh Token')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        if (commandName === 'list') {
            const users = getAllUsers();
            const userIds = Object.keys(users);
            
            if (userIds.length === 0) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('📊 ฐานข้อมูลว่าง')
                    .setDescription('ยังไม่มีคนกด Verify ในฐานข้อมูลเลยครับ')
                    .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('📊 ฐานข้อมูลผู้ใช้ทั้งหมด')
                .setDescription(`มีผู้ใช้ที่ยืนยันตัวตนทั้งหมด **${userIds.length}** คน`)
                .addFields(
                    { name: '📋 รายชื่อ ID', value: userIds.join('\n') || 'ไม่มีข้อมูล', inline: false }
                )
                .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            if (userIds.length > 20) {
                const buffer = Buffer.from(userIds.join('\n'), 'utf-8');
                const attachment = new AttachmentBuilder(buffer, { name: 'all_users_list.txt' });
                await interaction.reply({ 
                    embeds: [embed.setDescription(`มีผู้ใช้ที่ยืนยันตัวตนทั้งหมด **${userIds.length}** คน`)], 
                    files: [attachment], 
                    ephemeral: true 
                });
            } else {
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }

        if (commandName === 'check') {
            const users = getAllUsers();
            const userIds = Object.keys(users);
            
            if (userIds.length === 0) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('📊 ฐานข้อมูลว่าง')
                    .setDescription('ยังไม่มีคนกด Verify ในฐานข้อมูลเลยครับ')
                    .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }

            const loadingEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⏳ Process')
                .setDescription('กำลังตรวจสอบรายชื่อกับสมาชิกในเซิร์ฟเวอร์...')
                .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            
            await interaction.reply({ embeds: [loadingEmbed], ephemeral: true });

            const guildMembers = await interaction.guild.members.fetch(); 
            const membersInServer = userIds.filter(id => guildMembers.has(id));

            if (membersInServer.length === 0) {
                const resultEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('📊 Check Result')
                    .setDescription('**ไม่มีคนที่เคย Verify อยู่ในเซิร์ฟเวอร์นี้เลย**')
                    .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.editReply({ embeds: [resultEmbed] });
            }

            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Success')
                .setDescription(`มีผู้ใช้ที่เคย Verify และอยู่ในเซิร์ฟเวอร์นี้ **${membersInServer.length}** คน`)
                .addFields(
                    { name: '📋 รายชื่อ ID', value: membersInServer.join('\n') || 'ไม่มีข้อมูล', inline: false }
                )
                .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            if (membersInServer.length > 20) {
                const buffer = Buffer.from(membersInServer.join('\n'), 'utf-8');
                const attachment = new AttachmentBuilder(buffer, { name: 'verified_in_server.txt' });
                await interaction.editReply({ 
                    embeds: [embed.setDescription(`มีผู้ใช้ที่เคย Verify และอยู่ในเซิร์ฟเวอร์นี้ **${membersInServer.length}** คน`)], 
                    files: [attachment] 
                });
            } else {
                await interaction.editReply({ embeds: [embed] });
            }
        }

        if (commandName === 'checktoken') {
            const targetUser = options.getUser('user');
            const data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
            const userData = data[targetUser.id];
            
            if (!userData) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Failed')
                    .setDescription(`ไม่พบข้อมูลของ **${targetUser.username}** ในระบบ`)
                    .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }
            
            const isExpired = userData.expiresAt < Date.now();
            const hasRefresh = !!userData.refreshToken;
            const isRefreshExpired = hasRefresh && (Date.now() - userData.expiresAt > 7 * 24 * 60 * 60 * 1000);
            const timeLeft = Math.floor((userData.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
            
            const embed = new EmbedBuilder()
                .setColor(isExpired ? '#FF0000' : '#00FF00')
                .setTitle(`🔍 สถานะ Token ของ ${targetUser.username}`)
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '📊 สถานะ', value: isExpired ? '❌ หมดอายุแล้ว' : '✅ ยังใช้งานได้', inline: true },
                    { name: '🔄 Refresh Token', value: hasRefresh ? (isRefreshExpired ? '⚠️ หมดอายุ' : '✅ มี') : '❌ ไม่มี', inline: true },
                    { name: '📅 หมดอายุเมื่อ', value: new Date(userData.expiresAt).toLocaleString('th-TH'), inline: false },
                    { name: '⏳ เวลาที่เหลือ', value: isExpired ? 'หมดอายุแล้ว' : `${timeLeft} วัน`, inline: false }
                )
                .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (commandName === 'cleanup') {
            await interaction.reply({ 
                embeds: [
                    new EmbedBuilder()
                        .setColor('#FFA500')
                        .setTitle('⏳ Clenup...')
                        .setDescription('กำลังลบข้อมูล Token ที่หมดอายุ...')
                        .setFooter({ text: 'ระบบ Verify', iconURL: client.user.displayAvatarURL() })
                        .setTimestamp()
                ], 
                ephemeral: true 
            });
            
            const cleaned = cleanupExpiredTokens();
            
            const resultEmbed = new EmbedBuilder()
                .setColor(cleaned > 0 ? '#00FF00' : '#FFA500')
                .setTitle('🧹 Cleanup Success')
                .setDescription(`ลบข้อมูลที่หมดอายุแล้ว **${cleaned}** รายการ`)
                .setFooter({ text: `สั่งโดย ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [resultEmbed] });
        }
    }

    if (interaction.isButton()) {
        const ownerId = process.env.OWNER_ID;
        
        if (interaction.user.id !== ownerId) {
            const errorEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⛔ Failed')
                .setDescription('ปุ่มนี้สงวนไว้สำหรับ **เจ้าของบอท** เท่านั้น!')
                .setFooter({ text: 'ระบบความปลอดภัย', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
        }

        if (interaction.customId === 'serex_add') {
            const modal = new ModalBuilder()
                .setCustomId('serex_add_modal')
                .setTitle('📥 Add Member');

            const amountInput = new TextInputBuilder()
                .setCustomId('amount_input')
                .setLabel('จำนวนคนที่ต้องการดึง')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('เช่น 10')
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(5);

            const row = new ActionRowBuilder().addComponents(amountInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
        }

        if (interaction.customId === 'serex_check') {
            await interaction.deferReply({ ephemeral: true });
            
            const users = getAllUsers();
            const userIds = Object.keys(users);
            
            if (userIds.length === 0) {
                const embed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('📊 ฐานข้อมูลว่าง')
                    .setDescription('ยังไม่มีคนกด Verify ในฐานข้อมูลเลยครับ')
                    .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            const guildMembers = await interaction.guild.members.fetch(); 
            const membersInServer = userIds.filter(id => guildMembers.has(id));

            const embed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('✅ Check Result')
                .setDescription(`**สถิติในเซิร์ฟเวอร์นี้**`)
                .addFields(
                    { name: '📊 ผู้ใช้ในฐานข้อมูลทั้งหมด', value: `${userIds.length} คน`, inline: true },
                    { name: '👥 อยู่ในเซิร์ฟเวอร์นี้', value: `${membersInServer.length} คน`, inline: true },
                    { name: '📤 ยังไม่ได้อยู่ในเซิร์ฟเวอร์', value: `${userIds.length - membersInServer.length} คน`, inline: true }
                )
                .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            if (membersInServer.length > 0 && membersInServer.length <= 10) {
                embed.addFields(
                    { name: '📋 รายชื่อ ID ที่อยู่ในเซิร์ฟเวอร์', value: membersInServer.join('\n'), inline: false }
                );
            }

            await interaction.editReply({ embeds: [embed] });
        }

        if (interaction.customId === 'serex_refresh') {
            await interaction.deferReply({ ephemeral: true });
            
            const loadingEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('🔄 Refresh Token...')
                .setDescription('กำลังรีเฟรช Token ของสมาชิกทุกคนในฐานข้อมูล\nกรุณารอสักครู่...')
                .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [loadingEmbed] });
            
            const result = await refreshAllTokens();
            
            const resultEmbed = new EmbedBuilder()
                .setColor(result.failCount === 0 ? '#00FF00' : '#FFA500')
                .setTitle('🔄 Refresh Token')
                .setDescription('**ผลลัพธ์การ Refresh Token**')
                .addFields(
                    { name: '✅ Success', value: `${result.successCount} คน`, inline: true },
                    { name: '❌ Failed', value: `${result.failCount} คน`, inline: true }
                )
                .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [resultEmbed] });
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'serex_add_modal') {
            const amount = parseInt(interaction.fields.getTextInputValue('amount_input'));
            
            if (isNaN(amount) || amount < 1) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Failed')
                    .setDescription('กรุณาใส่จำนวนที่เป็นตัวเลขมากกว่า 0')
                    .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const currentGuildId = interaction.guildId; 
            const guild = interaction.guild;
            const users = getAllUsers();
            let userIds = Object.keys(users);

            if (userIds.length === 0) {
                const errorEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('❌ Failed')
                    .setDescription('ยังไม่มีคนกด Verify ในฐานข้อมูล')
                    .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.editReply({ embeds: [errorEmbed] });
            }

            await guild.members.fetch(); 
            let newUsersToPull = userIds.filter(id => !guild.members.cache.has(id));

            if (newUsersToPull.length === 0) {
                const resultEmbed = new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('✅ Success')
                    .setDescription('สมาชิกทุกคนในฐานข้อมูล อยู่ในเซิร์ฟเวอร์นี้ครบหมดแล้ว')
                    .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                    .setTimestamp();
                return interaction.editReply({ embeds: [resultEmbed] });
            }

            const targetAmount = Math.min(amount, newUsersToPull.length);
            
            const progressEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⏳ Process')
                .setDescription(`กำลังดึงสมาชิกใหม่ **${targetAmount}** คนโปรดรอ`)
                .setFooter({ text: 'ระบบ Serex', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [progressEmbed] });

            (async () => {
                let successCount = 0;
                let failCount = 0;
                let refreshFailCount = 0;
                let successList = [];
                let failList = [];

                for (let i = 0; i < targetAmount; i++) {
                    const userId = newUsersToPull[i];
                    
                    const validToken = await getValidAccessToken(userId);
                    
                    if (!validToken) {
                        failCount++;
                        refreshFailCount++;
                        failList.push(userId);
                        console.log(`ไม่สามารถ Refresh Token สำหรับ ${userId}`);
                        continue;
                    }

                    try {
                        const response = await axios.put(
                            `https://discord.com/api/guilds/${currentGuildId}/members/${userId}`,
                            { access_token: validToken },
                            {
                                headers: {
                                    'Authorization': `Bot ${process.env.BOT_TOKEN}`,
                                    'Content-Type': 'application/json'
                                }
                            }
                        );
                        
                        if (response.status === 201 || response.status === 204) {
                            successCount++;
                            successList.push(userId);
                        } else {
                            failCount++;
                            failList.push(userId);
                        }

                    } catch (error) {
                        failCount++;
                        failList.push(userId);
                        if (error.response && error.response.status === 429) {
                            const retryAfter = error.response.data.retry_after || 5;
                            console.log(`Rate Limit: พัก ${retryAfter} วินาที`);
                            await delay(retryAfter * 1000);
                        }
                    }
                    
                    await delay(1500);
                }

                const resultEmbed = new EmbedBuilder()
                    .setColor(successCount > 0 ? '#00FF00' : '#FF0000')
                    .setTitle('Result Added')
                    .setDescription(`**ผลลัพธ์การดึงสมาชิก**`)
                    .addFields(
                        { name: '✅ Success', value: `${successCount} คน`, inline: true },
                        { name: '❌ Failed', value: `${failCount} คน`, inline: true },
                        { name: '🔄 Refresh Cant/Expire', value: `${refreshFailCount} คน`, inline: true }
                    )
                    .setFooter({ text: `สั่งโดย ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp();

                if (successList.length > 0 && successList.length <= 10) {
                    resultEmbed.addFields(
                        { name: '✅ สำเร็จ (ID)', value: successList.join('\n'), inline: false }
                    );
                }

                if (refreshFailCount > 0) {
                    resultEmbed.setDescription(`${resultEmbed.data.description}\n\n⚠️ ผู้ใช้ที่ Refresh ไม่ได้หรือ Token หมดอายุ ต้องกด Verify ใหม่`);
                }

                await interaction.editReply({ embeds: [resultEmbed] });
            })();
        }
    }
});

client.login(process.env.BOT_TOKEN);