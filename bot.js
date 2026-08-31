require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
const ChatHandler = require('./chat-handler');
const PaymentHandler = require('./payment-handler');
const schedule = require('node-schedule'); // ✅ ДОБАВЛЕНО

// Настройка базы данных
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Создание бота
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Инициализация обработчиков
const chatHandler = new ChatHandler(bot);
const paymentHandler = new PaymentHandler(bot);

// Express сервер для Railway
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
    res.json({ 
        status: 'running',
        bot: 'Tappo Bot',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// Константы
const REFERRAL_BONUS = 50;
const MIN_TASK_REWARD = 15;
const MAX_TASK_REWARD = 50;
const WELCOME_BONUS = 100;
const CHANNEL_ID = '@tappo_piar'; // ✅ ДОБАВЛЕНО — канал для уведомлений

// 🛡️ СПИСОК АДМИНИСТРАТОРОВ
const ADMINS = [
    6919104818,  // 👤 Ваш Telegram ID
    1669690875,  // 👤 Второй админ
];

// Проверка прав администратора
function isAdmin(userId) {
    return ADMINS.includes(userId);
}

// Функции для работы с базой данных
const db = {
    async getUser(userId) {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        return result.rows[0];
    },

    async createUser(userId, username, firstName, referredBy = null) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            const result = await client.query(
                'INSERT INTO users (id, username, first_name, referred_by, balance) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [userId, username, firstName, referredBy, WELCOME_BONUS]
            );
            
            await client.query(
                'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                [userId, WELCOME_BONUS, 'welcome_bonus', '🎉 Приветственный бонус']
            );
            
            if (referredBy) {
                await client.query(
                    'UPDATE users SET balance = balance + $1, referral_count = referral_count + 1 WHERE id = $2',
                    [REFERRAL_BONUS, referredBy]
                );
                await client.query(
                    'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                    [referredBy, REFERRAL_BONUS, 'referral_bonus', `Реферальный бонус за пользователя ${username || userId}`]
                );
            }
            
            await client.query('COMMIT');
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    async updateBalance(userId, amount, type, description) {
        await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, userId]);
        await pool.query(
            'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
            [userId, amount, type, description]
        );
    },

    async getActiveTasks(excludeUserId = null, limit = 10) {
        let query = 'SELECT t.*, u.username as owner_username FROM tasks t JOIN users u ON t.owner_id = u.id WHERE t.is_active = true AND t.total_budget > t.completed_count * t.reward';
        let params = [];
        
        if (excludeUserId) {
            query += ' AND t.owner_id != $1';
            params.push(excludeUserId);
        }
        
        query += ' ORDER BY t.created_at DESC LIMIT $' + (params.length + 1);
        params.push(limit);
        
        const result = await pool.query(query, params);
        return result.rows;
    },

    async createTask(ownerId, channelUsername, reward, totalBudget) {
        const result = await pool.query(
            'INSERT INTO tasks (owner_id, channel_username, reward, total_budget) VALUES ($1, $2, $3, $4) RETURNING *',
            [ownerId, channelUsername, reward, totalBudget]
        );
        return result.rows[0];
    },

    async checkSubscription(userId, channelUsername) {
        try {
            const chatMember = await bot.getChatMember(`@${channelUsername}`, userId);
            const subscribedStatuses = ['member', 'administrator', 'creator'];
            return subscribedStatuses.includes(chatMember.status);
        } catch (error) {
            console.error(`Ошибка проверки подписки на @${channelUsername}:`, error);
            if (error.response && error.response.body) {
                const description = error.response.body.description || '';
                if (description.includes('bot is not a member') || 
                    description.includes('chat not found') ||
                    description.includes('USER_NOT_PARTICIPANT')) {
                    return true;
                }
            }
            return false;
        }
    },

    async completeTask(taskId, userId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            const existingCompletion = await client.query(
                'SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2',
                [taskId, userId]
            );
            
            if (existingCompletion.rows.length > 0) {
                throw new Error('Задание уже выполнено');
            }
            
            const taskResult = await client.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
            const task = taskResult.rows[0];
            
            if (!task || !task.is_active) {
                throw new Error('Задание не найдено или неактивно');
            }
            
            if (task.total_budget < (task.completed_count + 1) * task.reward) {
                throw new Error('Бюджет задания исчерпан');
            }
            
            const isSubscribed = await this.checkSubscription(userId, task.channel_username);
            
            if (!isSubscribed) {
                throw new Error('Вы не подписаны на канал! Подпишитесь и попробуйте снова.');
            }
            
            await client.query(
                'INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)',
                [taskId, userId]
            );
            
            await client.query(
                'UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1',
                [taskId]
            );
            
            await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2',
                [task.reward, userId]
            );
            
            await client.query(
                'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                [userId, task.reward, 'task_reward', `Награда за выполнение задания: @${task.channel_username}`]
            );
            
            await client.query('COMMIT');
            return task;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    async getUserTasks(userId) {
        const result = await pool.query('SELECT * FROM tasks WHERE owner_id = $1 ORDER BY created_at DESC', [userId]);
        return result.rows;
    },

    async isTaskCompleted(taskId, userId) {
        const result = await pool.query(
            'SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2',
            [taskId, userId]
        );
        return result.rows.length > 0;
    }
};

// Клавиатуры
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '💰 Заработать' }, { text: '📢 Рекламировать' }],
            [{ text: '👤 Мой кабинет' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const cabinetKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '💳 Пополнить баланс', callback_data: 'deposit' }],
            [{ text: '👥 Реферальная система', callback_data: 'referral' }],
            [{ text: '📋 Мои задания', callback_data: 'my_tasks' }],
            [{ text: '📊 История транзакций', callback_data: 'transactions' }]
        ]
    }
};

// Обработчики команд
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    const firstName = msg.from.first_name;
    
    if (msg.chat.type !== 'private') {
        return;
    }
    
    try {
        let user = await db.getUser(userId);
        
        if (!user) {
            const referralCode = match[1] ? match[1].trim() : null;
            let referredBy = null;
            
            if (referralCode && referralCode.startsWith('_')) {
                referredBy = parseInt(referralCode.substring(1));
                if (referredBy === userId) {
                    referredBy = null;
                }
            }
            
            user = await db.createUser(userId, username, firstName, referredBy);
            
            let welcomeMessage = `🎉 Добро пожаловать в Tappo!\n\n`;
            welcomeMessage += `💰 Вам начислен приветственный бонус: <b>${WELCOME_BONUS} коинов</b>!\n\n`;
            welcomeMessage += `💎 Зарабатывайте коины, выполняя задания по подписке на каналы\n`;
            welcomeMessage += `📢 Создавайте свои задания для продвижения каналов\n`;
            welcomeMessage += `👥 Приглашайте друзей и получайте бонусы\n\n`;
            
            if (referredBy) {
                welcomeMessage += `🎁 Вы присоединились по реферальной ссылке! Ваш реферер получил ${REFERRAL_BONUS} коинов.\n\n`;
            }
            
            welcomeMessage += `Выберите действие в меню ниже:`;
            
            bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML', ...mainKeyboard });
        } else {
            bot.sendMessage(chatId, `👋 С возвращением, ${firstName}!\n\nВыберите действие:`, mainKeyboard);
        }
    } catch (error) {
        console.error('Error in /start:', error);
        bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.');
    }
});

// Обработка кнопок
bot.on('message', async (msg) => {
    if (msg.text && !msg.text.startsWith('/') && msg.chat.type === 'private') {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        try {
            const user = await db.getUser(userId);
            if (!user) {
                bot.sendMessage(chatId, 'Пожалуйста, начните с команды /start');
                return;
            }
            
            switch (msg.text) {
                case '💰 Заработать':
                    await handleEarnCommand(chatId, userId);
                    break;
                    
                case '📢 Рекламировать':
                    await handleAdvertiseCommand(chatId, userId);
                    break;
                    
                case '👤 Мой кабинет':
                    await handleCabinetCommand(chatId, user);
                    break;
                    
                default:
                    if (msg.text.startsWith('создать ')) {
                        await handleCreateTask(msg);
                    } else {
                        bot.sendMessage(chatId, 'Используйте кнопки меню для навигации.', mainKeyboard);
                    }
            }
        } catch (error) {
            console.error('Error handling message:', error);
            bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.');
        }
    }
});

// Функции обработки команд
async function handleEarnCommand(chatId, userId) {
    const tasks = await db.getActiveTasks(userId, 5);
    
    if (tasks.length === 0) {
        bot.sendMessage(chatId, '😔 В данный момент нет доступных заданий.\n\nПопробуйте позже или создайте свое задание!');
        return;
    }
    
    let message = '💰 Доступные задания:\n\n';
    const keyboard = [];
    
    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const isCompleted = await db.isTaskCompleted(task.id, userId);
        
        message += `${i + 1}. Подписаться на @${task.channel_username}\n`;
        message += `💎 Награда: ${task.reward} коинов\n`;
        message += `📊 Выполнено: ${task.completed_count}/${Math.floor(task.total_budget / task.reward)}\n`;
        
        if (isCompleted) {
            message += `✅ Вы уже выполнили это задание\n\n`;
        } else {
            message += `🔗 Создано: @${task.owner_username || 'Неизвестно'}\n\n`;
            keyboard.push([{
                text: `Выполнить задание ${i + 1}`,
                callback_data: `complete_task_${task.id}`
            }]);
        }
    }
    
    keyboard.push([{ text: '🔄 Обновить список', callback_data: 'refresh_tasks' }]);
    
    bot.sendMessage(chatId, message, {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function handleAdvertiseCommand(chatId, userId) {
    const user = await db.getUser(userId);
    
    let message = '📢 Создание задания для продвижения канала\n\n';
    message += `💰 Ваш баланс: ${user.balance} коинов\n\n`;
    message += `📝 Для создания задания отправьте сообщение в формате:\n`;
    message += `<code>создать @канал награда бюджет</code>\n\n`;
    message += `📋 Пример:\n`;
    message += `<code>создать @example_channel 25 500</code>\n\n`;
    message += `⚖️ Правила:\n`;
    message += `• Награда: от ${MIN_TASK_REWARD} до ${MAX_TASK_REWARD} коинов за подписку\n`;
    message += `• Минимальный бюджет: ${MIN_TASK_REWARD} коинов\n`;
    message += `• Бюджет полностью списывается с вашего баланса\n`;
    message += `• Максимум выполнений = бюджет ÷ награда\n`;
    message += `•❗️ВНИМАНИЕ❗️-Добавьте бота @tappop_bot в администраторы своего канала`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
}

async function handleCabinetCommand(chatId, user) {
    const referralLink = `https://t.me/tappop_bot?start=_${user.id}`;
    
    let message = `👤 Личный кабинет\n\n`;
    message += `🆔 Ваш ID: <code>${user.id}</code>\n`;
    message += `💰 Баланс: <b>${user.balance}</b> коинов\n`;
    message += `👥 Приглашено рефералов: <b>${user.referral_count}</b>\n`;
    message += `📅 Регистрация: ${new Date(user.created_at).toLocaleDateString('ru-RU')}\n\n`;
    message += `💡 Заработано с рефералов: <b>${user.referral_count * REFERRAL_BONUS}</b> коинов`;
    
    bot.sendMessage(chatId, message, { 
        parse_mode: 'HTML',
        ...cabinetKeyboard 
    });
}

// Обработка callback кнопок
bot.on('callback_query', async (callbackQuery) => {
    const action = callbackQuery.data;
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    
    try {
        if (action.startsWith('complete_task_')) {
            const taskId = parseInt(action.split('_')[2]);
            await handleTaskCompletion(chatId, userId, taskId);
        } else if (action === 'refresh_tasks') {
            await handleEarnCommand(chatId, userId);
        } else if (action === 'referral') {
            await handleReferralSystem(chatId, userId);
        } else if (action === 'my_tasks') {
            await handleMyTasks(chatId, userId);
        } else if (action === 'transactions') {
            await handleTransactions(chatId, userId);
        } else if (action === 'deposit') {
            await handleDeposit(chatId, userId);
        }
        
        bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Error handling callback:', error);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Произошла ошибка' });
    }
});

async function handleTaskCompletion(chatId, userId, taskId) {
    try {
        const task = await db.completeTask(taskId, userId);
        
        const message = `✅ Задание успешно выполнено!\n\n` +
                       `📺 Канал: @${task.channel_username}\n` +
                       `💎 Получено: ${task.reward} коинов\n\n` +
                       `🎉 Спасибо за участие!`;
        
        bot.sendMessage(chatId, message);
    } catch (error) {
        let errorMessage = '❌ Не удалось выполнить задание.';
        if (error.message === 'Задание уже выполнено') {
            errorMessage = '⚠️ Вы уже выполнили это задание!';
        } else if (error.message === 'Бюджет задания исчерпан') {
            errorMessage = '😞 Бюджет этого задания уже исчерпан!';
        } else if (error.message === 'Вы не подписаны на канал! Подпишитесь и попробуйте снова.') {
            errorMessage = '❌ Вы не подписаны на канал!\n\n' +
                          `📺 Подпишитесь на @${error.taskChannel || 'канал'}\n` +
                          `🔄 После подписки нажмите "Выполнить задание" снова.`;
        }
        
        bot.sendMessage(chatId, errorMessage);
    }
}

async function handleReferralSystem(chatId, userId) {
    const user = await db.getUser(userId);
    const referralLink = `https://t.me/tappop_bot?start=_${user.id}`;
    
    let message = `👥 Реферальная система\n\n`;
    message += `🔗 <b>Ваша реферальная ссылка:</b>\n`;
    message += `<code>${referralLink}</code>\n\n`;
    message += `📊 <b>Статистика:</b>\n`;
    message += `• Приглашено друзей: <b>${user.referral_count}</b>\n`;
    message += `• Заработано с рефералов: <b>${user.referral_count * REFERRAL_BONUS}</b> коинов\n\n`;
    message += `💡 <b>Как это работает:</b>\n`;
    message += `• Поделитесь ссылкой с друзьями\n`;
    message += `• За каждого нового пользователя получаете <b>${REFERRAL_BONUS} коинов</b>\n`;
    message += `• Ваши друзья тоже смогут зарабатывать!`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
}

async function handleMyTasks(chatId, userId) {
    const tasks = await db.getUserTasks(userId);
    
    if (tasks.length === 0) {
        bot.sendMessage(chatId, '📋 У вас пока нет созданных заданий.\n\nИспользуйте раздел "Рекламировать" для создания заданий.');
        return;
    }
    
    let message = '📋 Ваши задания:\n\n';
    
    tasks.forEach((task, index) => {
        const maxCompletions = Math.floor(task.total_budget / task.reward);
        const status = task.is_active ? '🟢 Активно' : '🔴 Завершено';
        const progress = `${task.completed_count}/${maxCompletions}`;
        
        message += `${index + 1}. @${task.channel_username}\n`;
        message += `${status} | 💎 ${task.reward} коинов\n`;
        message += `📊 Выполнено: ${progress}\n`;
        message += `💰 Потрачено: ${task.completed_count * task.reward}/${task.total_budget}\n`;
        message += `📅 ${new Date(task.created_at).toLocaleDateString('ru-RU')}\n\n`;
    });
    
    bot.sendMessage(chatId, message);
}

async function handleTransactions(chatId, userId) {
    const transactions = await paymentHandler.getTransactionHistory(userId, 10);
    
    if (transactions.length === 0) {
        bot.sendMessage(chatId, '📊 История транзакций пуста.');
        return;
    }
    
    let message = '📊 История транзакций (последние 10):\n\n';
    
    transactions.forEach((tx, index) => {
        const date = new Date(tx.created_at).toLocaleDateString('ru-RU');
        const time = new Date(tx.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const amount = tx.amount > 0 ? `+${tx.amount}` : tx.amount;
        const emoji = tx.amount > 0 ? '💚' : '🔴';
        
        message += `${emoji} ${amount} коинов\n`;
        message += `📝 ${tx.description}\n`;
        message += `📅 ${date} ${time}\n\n`;
    });
    
    bot.sendMessage(chatId, message);
}

async function handleDeposit(chatId, userId) {
    let message = `💳 Пополнение баланса через Telegram Stars\n\n`;
    message += `⭐ Курс обмена: 1 Star = 10 коинов\n\n`;
    message += `Выберите пакет для покупки:`;
    
    const packages = [
        { stars: 10, coins: 100 },
        { stars: 25, coins: 250 },
        { stars: 50, coins: 500 },
        { stars: 100, coins: 1000 },
        { stars: 250, coins: 2500 }
    ];
    
    const keyboard = packages.map(pkg => [{
        text: `${pkg.stars} ⭐ → ${pkg.coins} коинов`,
        callback_data: `buy_${pkg.stars}`
    }]);
    
    bot.sendMessage(chatId, message, {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

// Обработка создания заданий
async function handleCreateTask(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const parts = msg.text.split(' ');
        if (parts.length !== 4) {
            bot.sendMessage(chatId, '❌ Неверный формат!\n\nИспользуйте: <code>создать @канал награда бюджет</code>', { parse_mode: 'HTML' });
            return;
        }
        
        const channel = parts[1].replace('@', '');
        const reward = parseInt(parts[2]);
        const budget = parseInt(parts[3]);
        
        if (isNaN(reward) || isNaN(budget)) {
            bot.sendMessage(chatId, '❌ Награда и бюджет должны быть числами!');
            return;
        }
        
        if (reward < MIN_TASK_REWARD || reward > MAX_TASK_REWARD) {
            bot.sendMessage(chatId, `❌ Награда должна быть от ${MIN_TASK_REWARD} до ${MAX_TASK_REWARD} коинов!`);
            return;
        }
        
        if (budget < reward) {
            bot.sendMessage(chatId, '❌ Бюджет должен быть не менее размера награды!');
            return;
        }
        
        // Проверка: есть ли бот в канале
        try {
            const botMember = await bot.getChatMember(`@${channel}`, bot.botInfo.id);
            const isBotAdmin = ['administrator', 'creator'].includes(botMember.status);
            
            if (!isBotAdmin) {
                bot.sendMessage(
                    chatId, 
                    `❌ <b>Бот не является администратором канала @${channel}!</b>\n\n` +
                    `Добавьте бота <b>@tappop_bot</b> в администраторы вашего канала, чтобы создавать задания.\n\n` +
                    `📋 <b>Как добавить:</b>\n` +
                    `1️⃣ Зайдите в настройки канала\n` +
                    `2️⃣ Выберите "Администраторы"\n` +
                    `3️⃣ Нажмите "Добавить администратора"\n` +
                    `4️⃣ Найдите @tappop_bot\n` +
                    `5️⃣ Дайте ему права (можно минимальные)`,
                    { parse_mode: 'HTML' }
                );
                return;
            }
        } catch (error) {
            console.error(`Ошибка проверки бота в канале @${channel}:`, error);
            
            let errorMessage = `❌ <b>Не удалось проверить канал @${channel}!</b>\n\n`;
            
            if (error.response && error.response.body) {
                const description = error.response.body.description || '';
                if (description.includes('chat not found')) {
                    errorMessage += `Канал @${channel} не найден. Проверьте правильность написания.`;
                } else if (description.includes('bot is not a member')) {
                    errorMessage += 
                        `Бот <b>@tappop_bot</b> не добавлен в канал @${channel}.\n\n` +
                        `Добавьте бота в администраторы канала и попробуйте снова.`;
                } else {
                    errorMessage += `Ошибка: ${description}`;
                }
            } else {
                errorMessage += `Не удалось проверить канал. Убедитесь, что канал существует и бот добавлен в администраторы.`;
            }
            
            bot.sendMessage(chatId, errorMessage, { parse_mode: 'HTML' });
            return;
        }
        
        const user = await db.getUser(userId);
        if (user.balance < budget) {
            bot.sendMessage(chatId, `❌ Недостаточно средств!\n\n💰 Ваш баланс: ${user.balance} коинов\n💳 Требуется: ${budget} коинов`);
            return;
        }
        
        await db.updateBalance(userId, -budget, 'task_payment', `Создание задания для @${channel}`);
        
        const task = await db.createTask(userId, channel, reward, budget);
        
        const maxCompletions = Math.floor(budget / reward);
        let message = `✅ Задание успешно создано!\n\n`;
        message += `📺 Канал: @${channel}\n`;
        message += `💎 Награда: ${reward} коинов за подписку\n`;
        message += `💰 Бюджет: ${budget} коинов\n`;
        message += `👥 Максимум выполнений: ${maxCompletions}\n\n`;
        message += `🚀 Задание добавлено в общий список и будет показано пользователям в разделе "Заработать".`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        
        await notifyUsersAboutNewTask(task, reward, channel);
        
    } catch (error) {
        console.error('Error creating task:', error);
        bot.sendMessage(chatId, '❌ Произошла ошибка при создании задания. Попробуйте позже.');
    }
}

async function notifyUsersAboutNewTask(task, reward, channel) {
    try {
        const usersResult = await pool.query(`
            SELECT id FROM users 
            WHERE id != $1
            AND NOT EXISTS (
                SELECT 1 FROM task_completions 
                WHERE task_completions.task_id = $2 
                AND task_completions.user_id = users.id
            )
        `, [task.owner_id, task.id]);
        
        const users = usersResult.rows;
        
        if (users.length === 0) return;
        
        const batch = users.slice(0, 100);
        
        const notifyMessage = 
            `📢 <b>Новое задание!</b>\n\n` +
            `📺 Подпишись на @${channel}\n` +
            `💎 Награда: <b>${reward} коинов</b>\n\n` +
            `👉 Нажми "💰 Заработать" в боте, чтобы выполнить задание!`;
        
        for (const user of batch) {
            try {
                await bot.sendMessage(user.id, notifyMessage, { parse_mode: 'HTML' });
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {}
        }
        
        console.log(`📨 Уведомления о задании ${task.id} отправлены ${batch.length} пользователям`);
        
    } catch (error) {
        console.error('Ошибка отправки уведомлений:', error);
    }
}

// Инициализация базы данных
async function initDatabase() {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ Подключение к базе данных установлено');
        await createTablesIfNotExist();
    } catch (error) {
        console.error('❌ Ошибка подключения к базе данных:', error);
        process.exit(1);
    }
}

// Создание таблиц если они не существуют
async function createTablesIfNotExist() {
    try {
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'users'
            );
        `);

        if (!tableCheck.rows[0].exists) {
            console.log('🔄 Создание таблиц базы данных...');

            await pool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id BIGINT PRIMARY KEY,
                    username VARCHAR(255),
                    first_name VARCHAR(255),
                    balance INTEGER DEFAULT 0,
                    referral_count INTEGER DEFAULT 0,
                    referred_by BIGINT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS tasks (
                    id SERIAL PRIMARY KEY,
                    owner_id BIGINT NOT NULL,
                    channel_username VARCHAR(255) NOT NULL,
                    reward INTEGER NOT NULL CHECK (reward >= 15 AND reward <= 50),
                    total_budget INTEGER NOT NULL,
                    completed_count INTEGER DEFAULT 0,
                    is_active BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (owner_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS task_completions (
                    id SERIAL PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    user_id BIGINT NOT NULL,
                    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (task_id) REFERENCES tasks(id),
                    FOREIGN KEY (user_id) REFERENCES users(id),
                    UNIQUE(task_id, user_id)
                );

                CREATE TABLE IF NOT EXISTS chats (
                    id BIGINT PRIMARY KEY,
                    owner_id BIGINT NOT NULL,
                    chat_type VARCHAR(50) NOT NULL,
                    title VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (owner_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS chat_sponsors (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT NOT NULL,
                    sponsor_username VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (chat_id) REFERENCES chats(id),
                    UNIQUE(chat_id, sponsor_username)
                );

                CREATE TABLE IF NOT EXISTS transactions (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    amount INTEGER NOT NULL,
                    type VARCHAR(50) NOT NULL,
                    description TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                );

                CREATE INDEX IF NOT EXISTS idx_users_id ON users(id);
                CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id);
                CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active);
                CREATE INDEX IF NOT EXISTS idx_task_completions_user_task ON task_completions(user_id, task_id);
                CREATE INDEX IF NOT EXISTS idx_chats_owner_id ON chats(owner_id);
                CREATE INDEX IF NOT EXISTS idx_chat_sponsors_chat_id ON chat_sponsors(chat_id);
                CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
            `);

            console.log('✅ Таблицы базы данных созданы успешно!');
        } else {
            console.log('✅ Таблицы базы данных уже существуют');
        }
    } catch (error) {
        console.error('❌ Ошибка создания таблиц:', error);
        throw error;
    }
}

// Обработка ошибок
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled Rejection:', error);
});

// ═══════════════════════════════════════════════════════════
// 🚀 АДМИНИСТРАТОРСКИЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════

// Команда для рассылки
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
        return;
    }
    
    const messageText = match[1];
    
    try {
        const usersResult = await pool.query('SELECT id FROM users');
        const users = usersResult.rows;
        
        if (users.length === 0) {
            bot.sendMessage(chatId, '❌ Нет пользователей для рассылки.');
            return;
        }
        
        await bot.sendMessage(
            chatId, 
            `📨 Начинаю рассылку для ${users.length} пользователей...\n\n` +
            `Сообщение:\n${messageText}`
        );
        
        let successCount = 0;
        let failCount = 0;
        
        for (const user of users) {
            try {
                await bot.sendMessage(user.id, messageText, { parse_mode: 'HTML' });
                successCount++;
            } catch (error) {
                failCount++;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        bot.sendMessage(
            chatId,
            `✅ Рассылка завершена!\n\n` +
            `📤 Отправлено: ${successCount}\n` +
            `❌ Не доставлено: ${failCount}`
        );
        
    } catch (error) {
        console.error('Ошибка рассылки:', error);
        bot.sendMessage(chatId, '❌ Ошибка при выполнении рассылки.');
    }
});

bot.onText(/\/broadcast/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
        return;
    }
    
    bot.sendMessage(
        chatId,
        `📨 <b>Рассылка сообщения</b>\n\n` +
        `Отправьте сообщение для рассылки командой:\n` +
        `<code>/broadcast текст сообщения</code>\n\n` +
        `Пример:\n` +
        `<code>/broadcast Привет! У нас новый розыгрыш! 🎁</code>\n\n` +
        `⚠️ Сообщение будет отправлено ВСЕМ пользователям бота.`,
        { parse_mode: 'HTML' }
    );
});

// Статистика бота
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
        return;
    }
    
    try {
        const usersCount = await pool.query('SELECT COUNT(*) FROM users');
        const tasksCount = await pool.query('SELECT COUNT(*) FROM tasks WHERE is_active = true');
        const completionsCount = await pool.query('SELECT COUNT(*) FROM task_completions');
        const totalBalance = await pool.query('SELECT SUM(balance) FROM users');
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayTransactions = await pool.query(
            'SELECT COUNT(*), SUM(amount) FROM transactions WHERE created_at >= $1 AND amount > 0',
            [today]
        );
        
        const message = 
            `📊 <b>Статистика бота</b>\n\n` +
            `👥 <b>Пользователи:</b> ${usersCount.rows[0].count}\n` +
            `📢 <b>Активных заданий:</b> ${tasksCount.rows[0].count}\n` +
            `✅ <b>Выполнено заданий:</b> ${completionsCount.rows[0].count}\n` +
            `💰 <b>Общий баланс:</b> ${totalBalance.rows[0].sum || 0} коинов\n` +
            `📈 <b>Пополнений сегодня:</b> ${todayTransactions.rows[0].count || 0}\n` +
            `💳 <b>На сумму:</b> ${todayTransactions.rows[0].sum || 0} коинов\n\n` +
            `🕐 ${new Date().toLocaleString('ru-RU')}`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        
    } catch (error) {
        console.error('Ошибка статистики:', error);
        bot.sendMessage(chatId, '❌ Ошибка получения статистики.');
    }
});

// ═══════════════════════════════════════════════════════════
// 🎫 СИСТЕМА ПРОМОКОДОВ
// ═══════════════════════════════════════════════════════════

const promoDB = {
    async createPromo(code, amount, limit, expiresAt = null) {
        const result = await pool.query(
            `INSERT INTO promocodes (code, amount, limit_count, used_count, expires_at, is_active) 
             VALUES ($1, $2, $3, 0, $4, true) RETURNING *`,
            [code, amount, limit, expiresAt]
        );
        return result.rows[0];
    },

    async getPromo(code) {
        const result = await pool.query(
            'SELECT * FROM promocodes WHERE code = $1 AND is_active = true',
            [code]
        );
        return result.rows[0];
    },

    async hasUserUsedPromo(userId, promoId) {
        const result = await pool.query(
            'SELECT id FROM promo_uses WHERE user_id = $1 AND promo_id = $2',
            [userId, promoId]
        );
        return result.rows.length > 0;
    },

    async usePromo(userId, promoCode) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const promoResult = await client.query(
                'SELECT * FROM promocodes WHERE code = $1 AND is_active = true FOR UPDATE',
                [promoCode]
            );
            const promo = promoResult.rows[0];

            if (!promo) {
                throw new Error('Промокод не найден или неактивен');
            }

            if (promo.expires_at && new Date() > new Date(promo.expires_at)) {
                throw new Error('Срок действия промокода истек');
            }

            if (promo.limit_count !== -1 && promo.used_count >= promo.limit_count) {
                throw new Error('Лимит использований промокода исчерпан');
            }

            const usedCheck = await client.query(
                'SELECT id FROM promo_uses WHERE user_id = $1 AND promo_id = $2',
                [userId, promo.id]
            );
            if (usedCheck.rows.length > 0) {
                throw new Error('Вы уже использовали этот промокод');
            }

            await client.query(
                'INSERT INTO promo_uses (user_id, promo_id) VALUES ($1, $2)',
                [userId, promo.id]
            );

            await client.query(
                'UPDATE promocodes SET used_count = used_count + 1 WHERE id = $1',
                [promo.id]
            );

            await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2',
                [promo.amount, userId]
            );

            await client.query(
                'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                [userId, promo.amount, 'promo_bonus', `🎫 Бонус по промокоду: ${promoCode}`]
            );

            await client.query('COMMIT');
            return { promo, amount: promo.amount };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    },

    async getAllPromocodes() {
        const result = await pool.query(
            'SELECT * FROM promocodes ORDER BY created_at DESC'
        );
        return result.rows;
    },

    async deactivatePromo(promoId) {
        await pool.query(
            'UPDATE promocodes SET is_active = false WHERE id = $1',
            [promoId]
        );
    }
};

bot.onText(/\/promo (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const promoCode = match[1].trim().toUpperCase();

    try {
        const result = await promoDB.usePromo(userId, promoCode);
        
        bot.sendMessage(
            chatId,
            `✅ <b>Промокод активирован!</b>\n\n` +
            `🎫 Код: <b>${promoCode}</b>\n` +
            `💰 Получено: <b>${result.amount} коинов</b>\n\n` +
            `🎉 Приятного использования!`,
            { parse_mode: 'HTML' }
        );

    } catch (error) {
        let errorMessage = '❌ ';
        if (error.message === 'Промокод не найден или неактивен') {
            errorMessage += 'Промокод не найден или уже неактивен.';
        } else if (error.message === 'Срок действия промокода истек') {
            errorMessage += 'Срок действия этого промокода истек.';
        } else if (error.message === 'Лимит использований промокода исчерпан') {
            errorMessage += 'Лимит использований этого промокода исчерпан.';
        } else if (error.message === 'Вы уже использовали этот промокод') {
            errorMessage += 'Вы уже использовали этот промокод.';
        } else {
            errorMessage += error.message;
        }
        
        bot.sendMessage(chatId, errorMessage);
    }
});

bot.onText(/\/createpromo (.+) (\d+) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
        return;
    }

    const code = match[1].trim().toUpperCase();
    const amount = parseInt(match[2]);
    const limit = parseInt(match[3]);

    if (isNaN(amount) || amount <= 0) {
        bot.sendMessage(chatId, '❌ Сумма бонуса должна быть положительным числом.');
        return;
    }

    if (limit !== -1 && limit <= 0) {
        bot.sendMessage(chatId, '❌ Лимит должен быть -1 (безлимитный) или положительным числом.');
        return;
    }

    try {
        const promo = await promoDB.createPromo(code, amount, limit);
        
        const limitText = promo.limit_count === -1 ? '♾️ Безлимитный' : `${promo.limit_count} использований`;
        const expiresText = promo.expires_at ? `📅 Истекает: ${new Date(promo.expires_at).toLocaleDateString('ru-RU')}` : '♾️ Без срока';

        bot.sendMessage(
            chatId,
            `✅ <b>Промокод создан!</b>\n\n` +
            `🎫 Код: <b>${promo.code}</b>\n` +
            `💰 Бонус: <b>${promo.amount} коинов</b>\n` +
            `👥 Лимит: ${limitText}\n` +
            `${expiresText}\n\n` +
            `📋 Пользователи активируют промокод командой:\n` +
            `<code>/promo ${promo.code}</code>`,
            { parse_mode: 'HTML' }
        );

    } catch (error) {
        console.error('Ошибка создания промокода:', error);
        bot.sendMessage(chatId, '❌ Ошибка создания промокода. Возможно, такой код уже существует.');
    }
});

bot.onText(/\/promolist/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
        return;
    }

    try {
        const promos = await promoDB.getAllPromocodes();

        if (promos.length === 0) {
            bot.sendMessage(chatId, '📋 Промокодов пока нет.');
            return;
        }

        let message = '📋 <b>Список промокодов</b>\n\n';

        promos.forEach((promo, index) => {
            const status = promo.is_active ? '🟢 Активен' : '🔴 Неактивен';
            const limitText = promo.limit_count === -1 ? '♾️' : promo.limit_count;
            const expiresText = promo.expires_at ? new Date(promo.expires_at).toLocaleDateString('ru-RU') : '♾️';
            
            message += `${index + 1}. <b>${promo.code}</b>\n`;
            message += `   💰 ${promo.amount} коинов\n`;
            message += `   👥 ${promo.used_count}/${limitText}\n`;
            message += `   📅 ${expiresText}\n`;
            message += `   ${status}\n\n`;
        });

        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

    } catch (error) {
        console.error('Ошибка получения списка промокодов:', error);
        bot.sendMessage(chatId, '❌ Ошибка получения списка промокодов.');
    }
});

bot.onText(/\/disablepromo (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
        return;
    }

    const promoId = parseInt(match[1]);
    if (isNaN(promoId)) {
        bot.sendMessage(chatId, '❌ Укажите ID промокода. Используйте: /disablepromo ID');
        return;
    }

    try {
        await promoDB.deactivatePromo(promoId);
        bot.sendMessage(chatId, `✅ Промокод #${promoId} деактивирован.`);
    } catch (error) {
        console.error('Ошибка деактивации промокода:', error);
        bot.sendMessage(chatId, '❌ Ошибка деактивации промокода.');
    }
});

bot.onText(/\/promohelp/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '❌ У вас нет прав для этой команды.');
        return;
    }

    const message = 
        `📖 <b>Инструкция по промокодам</b>\n\n` +
        `<b>Создание:</b>\n` +
        `<code>/createpromo КОД СУММА ЛИМИТ</code>\n\n` +
        `📋 <b>Параметры:</b>\n` +
        `• КОД — любой текст (латиница, цифры)\n` +
        `• СУММА — количество коинов за промокод\n` +
        `• ЛИМИТ — -1 (безлимитный) или число (например, 100)\n\n` +
        `<b>Примеры:</b>\n` +
        `<code>/createpromo HAPPY2025 50 100</code> — 50 коинов для первых 100 человек\n` +
        `<code>/createpromo BONUS25 25 -1</code> — 25 коинов для всех\n\n` +
        `<b>Другие команды:</b>\n` +
        `<code>/promolist</code> — список всех промокодов\n` +
        `<code>/disablepromo ID</code> — деактивировать промокод по ID\n\n` +
        `<b>Как активируют пользователи:</b>\n` +
        `<code>/promo КОД</code> — например: /promo HAPPY2025`;

    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// ═══════════════════════════════════════════════════════════
// ⏰ АВТОМАТИЧЕСКИЕ УВЕДОМЛЕНИЯ
// ═══════════════════════════════════════════════════════════

// Функция отправки уведомления всем пользователям
async function sendNotificationToAll(message) {
    try {
        const usersResult = await pool.query('SELECT id FROM users');
        const users = usersResult.rows;
        
        if (users.length === 0) return;
        
        let successCount = 0;
        let failCount = 0;
        
        for (const user of users) {
            try {
                await bot.sendMessage(user.id, message, { parse_mode: 'HTML' });
                successCount++;
            } catch (error) {
                failCount++;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log(`📨 Уведомление отправлено ${successCount} пользователям, не доставлено ${failCount}`);
        
    } catch (error) {
        console.error('Ошибка отправки уведомлений:', error);
    }
}

// Функция отправки уведомления в канал
async function sendChannelNotification(message) {
    try {
        await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'HTML' });
        console.log('📨 Уведомление отправлено в канал');
    } catch (error) {
        console.error('Ошибка отправки в канал:', error);
    }
}

// Запуск автоматических уведомлений
function startAutoNotifications() {
    // Ежедневное напоминание в 14:00
    schedule.scheduleJob('0 14 * * *', async () => {
        const message = 
            `🌞 <b>Напоминание от Tappo!</b>\n\n` +
            `💰 Зарабатывайте коины в боте!\n` +
            `📢 Выполняйте задания и получайте награды!\n\n` +
            `👉 Перейти в бот: @tappop_bot`;
        
        await sendNotificationToAll(message);
        await sendChannelNotification(message);
    });
    
    console.log('⏰ Автоматические уведомления запущены!');
}

// Запуск
async function start() {
    await initDatabase();
    
    // ✅ ЗАПУСКАЕМ АВТОУВЕДОМЛЕНИЯ
    startAutoNotifications();
    
    console.log('🚀 Tappo Bot запущен и готов к работе!');
    console.log(`🌐 Бот доступен по адресу: @tappop_bot`);
}

start().catch(console.error);