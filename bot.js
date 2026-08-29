require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');
const ChatHandler = require('./chat-handler');
const PaymentHandler = require('./payment-handler');

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
        bot: 'Tick Bot',
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
const WELCOME_BONUS = 100; // 🎁 Приветственный бонус

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
            
            // Записываем транзакцию о получении приветственного бонуса
            await client.query(
                'INSERT INTO transactions (user_id, amount, type, description) VALUES ($1, $2, $3, $4)',
                [userId, WELCOME_BONUS, 'welcome_bonus', '🎉 Приветственный бонус']
            );
            
            // Начисляем бонус рефереру
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

    // ✅ НОВАЯ ФУНКЦИЯ: Проверка подписки пользователя на канал
    async checkSubscription(userId, channelUsername) {
        try {
            // Получаем информацию о членстве пользователя в канале
            const chatMember = await bot.getChatMember(`@${channelUsername}`, userId);
            
            // Статусы, которые означают, что пользователь подписан
            const subscribedStatuses = ['member', 'administrator', 'creator'];
            
            return subscribedStatuses.includes(chatMember.status);
        } catch (error) {
            // Если бот не может проверить (например, нет прав или канал приватный)
            console.error(`Ошибка проверки подписки на @${channelUsername}:`, error);
            
            // Если ошибка "бот не администратор" или "канал не найден" - пропускаем проверку
            if (error.response && error.response.body) {
                const description = error.response.body.description || '';
                if (description.includes('bot is not a member') || 
                    description.includes('chat not found') ||
                    description.includes('USER_NOT_PARTICIPANT')) {
                    // Если бот не может проверить - считаем, что подписка есть (доверие)
                    return true;
                }
            }
            return false;
        }
    },

    // ✅ ИСПРАВЛЕННАЯ ФУНКЦИЯ: с проверкой подписки
    async completeTask(taskId, userId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Проверяем, не выполнено ли уже задание
            const existingCompletion = await client.query(
                'SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2',
                [taskId, userId]
            );
            
            if (existingCompletion.rows.length > 0) {
                throw new Error('Задание уже выполнено');
            }
            
            // Получаем информацию о задании
            const taskResult = await client.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
            const task = taskResult.rows[0];
            
            if (!task || !task.is_active) {
                throw new Error('Задание не найдено или неактивно');
            }
            
            if (task.total_budget < (task.completed_count + 1) * task.reward) {
                throw new Error('Бюджет задания исчерпан');
            }
            
            // ✅ ПРОВЕРКА ПОДПИСКИ
            const isSubscribed = await this.checkSubscription(userId, task.channel_username);
            
            if (!isSubscribed) {
                throw new Error('Вы не подписаны на канал! Подпишитесь и попробуйте снова.');
            }
            
            // Записываем выполнение задания
            await client.query(
                'INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)',
                [taskId, userId]
            );
            
            // Обновляем счетчик выполнений
            await client.query(
                'UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1',
                [taskId]
            );
            
            // Начисляем награду
            await client.query(
                'UPDATE users SET balance = balance + $1 WHERE id = $2',
                [task.reward, userId]
            );
            
            // Записываем транзакцию
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
    
    // Проверяем, что это личное сообщение
    if (msg.chat.type !== 'private') {
        return;
    }
    
    try {
        let user = await db.getUser(userId);
        
        if (!user) {
            // Проверяем реферальную ссылку
            const referralCode = match[1] ? match[1].trim() : null;
            let referredBy = null;
            
            if (referralCode && referralCode.startsWith('_')) {
                referredBy = parseInt(referralCode.substring(1));
                if (referredBy === userId) {
                    referredBy = null; // Нельзя реферить самого себя
                }
            }
            
            user = await db.createUser(userId, username, firstName, referredBy);
            
            let welcomeMessage = `🎉 Добро пожаловать в Tappo⚡️!\n\n`;
            welcomeMessage += `💰 Вам начислен приветственный бонус: <b>${WELCOME_BONUS} коинов</b>!\n\n`;
            welcomeMessage += `💎 Зарабатывайте Tick коины, выполняя задания по подписке на каналы\n`;
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
                    // Проверяем, не создание ли задания
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
    message += `•❗️ВНИМАНИЕ❗️-Добавьте бота @tappop_bot в администарторы своего канала`;
    
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

// ✅ ИСПРАВЛЕННАЯ ФУНКЦИЯ: с проверкой подписки
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
        
        // Валидация
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
        
        const user = await db.getUser(userId);
        if (user.balance < budget) {
            bot.sendMessage(chatId, `❌ Недостаточно средств!\n\n💰 Ваш баланс: ${user.balance} коинов\n💳 Требуется: ${budget} коинов`);
            return;
        }
        
        // Списываем бюджет
        await db.updateBalance(userId, -budget, 'task_payment', `Создание задания для @${channel}`);
        
        // Создаем задание
        const task = await db.createTask(userId, channel, reward, budget);
        
        const maxCompletions = Math.floor(budget / reward);
        let message = `✅ Задание успешно создано!\n\n`;
        message += `📺 Канал: @${channel}\n`;
        message += `💎 Награда: ${reward} коинов за подписку\n`;
        message += `💰 Бюджет: ${budget} коинов\n`;
        message += `👥 Максимум выполнений: ${maxCompletions}\n\n`;
        message += `🚀 Задание добавлено в общий список и будет показано пользователям в разделе "Заработать".\n\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `⚠️ <b>ВАЖНО!</b> Чтобы проверка подписок работала:\n\n`;
        message += `1️⃣ Добавьте бота <b>@tappop_bot</b> в администраторы вашего канала\n`;
        message += `2️⃣ Дайте ему права (достаточно минимальных)\n`;
        message += `3️⃣ После этого пользователи смогут выполнять задания\n\n`;
        message += `❌ <b>Если бот не будет админом</b> — проверка подписок не сработает, и пользователи смогут получать награду без подписки!\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        message += `💡 <b>Как добавить бота в админы:</b>\n`;
        message += `• Зайдите в настройки канала\n`;
        message += `• Выберите "Администраторы"\n`;
        message += `• Нажмите "Добавить администратора"\n`;
        message += `• Найдите @tappop_bot\n`;
        message += `• Дайте ему права (можно минимальные)`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        
    } catch (error) {
        console.error('Error creating task:', error);
        bot.sendMessage(chatId, '❌ Произошла ошибка при создании задания. Попробуйте позже.');
    }
}

// Инициализация базы данных
async function initDatabase() {
    try {
        // Проверяем подключение
        await pool.query('SELECT NOW()');
        console.log('✅ Подключение к базе данных установлено');

        // Проверяем существование таблиц и создаем их при необходимости
        await createTablesIfNotExist();

    } catch (error) {
        console.error('❌ Ошибка подключения к базе данных:', error);
        process.exit(1);
    }
}

// Создание таблиц если они не существуют
async function createTablesIfNotExist() {
    try {
        // Проверяем существование таблицы users
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'users'
            );
        `);

        if (!tableCheck.rows[0].exists) {
            console.log('🔄 Создание таблиц базы данных...');

            // Создаем все таблицы
            await pool.query(`
                -- Создание таблицы пользователей
                CREATE TABLE IF NOT EXISTS users (
                    id BIGINT PRIMARY KEY,
                    username VARCHAR(255),
                    first_name VARCHAR(255),
                    balance INTEGER DEFAULT 0,
                    referral_count INTEGER DEFAULT 0,
                    referred_by BIGINT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                -- Создание таблицы заданий
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

                -- Создание таблицы выполненных заданий
                CREATE TABLE IF NOT EXISTS task_completions (
                    id SERIAL PRIMARY KEY,
                    task_id INTEGER NOT NULL,
                    user_id BIGINT NOT NULL,
                    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (task_id) REFERENCES tasks(id),
                    FOREIGN KEY (user_id) REFERENCES users(id),
                    UNIQUE(task_id, user_id)
                );

                -- Создание таблицы чатов с спонсорами
                CREATE TABLE IF NOT EXISTS chats (
                    id BIGINT PRIMARY KEY,
                    owner_id BIGINT NOT NULL,
                    chat_type VARCHAR(50) NOT NULL,
                    title VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (owner_id) REFERENCES users(id)
                );

                -- Создание таблицы спонсоров для чатов
                CREATE TABLE IF NOT EXISTS chat_sponsors (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT NOT NULL,
                    sponsor_username VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (chat_id) REFERENCES chats(id),
                    UNIQUE(chat_id, sponsor_username)
                );

                -- Создание таблицы транзакций
                CREATE TABLE IF NOT EXISTS transactions (
                    id SERIAL PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    amount INTEGER NOT NULL,
                    type VARCHAR(50) NOT NULL,
                    description TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                );

                -- Индексы для оптимизации
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

// Запуск
async function start() {
    await initDatabase();
    console.log('🚀 Tick Bot запущен и готов к работе!');
    console.log(`🌐 Бот доступен по адресу: @tappop_bot`);
}

start().catch(console.error);