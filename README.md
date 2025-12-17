# WaveSpeed Batch Generator - Полная Документация

## 🚀 Обзор

Это полнофункциональный Node.js/Express сервер для:
- **Пакетной генерации** через WaveSpeed Seedream v4.5 API
- **Архивирования результатов** в Airtable
- **Надежной обработки** с поллингом и вебхуками
- **Веб-интерфейса** для управления батчами

## 📋 Архитектура

```
┌─────────────────┐
│   Web UI (/app) │
└────────┬────────┘
         │
         v
┌─────────────────────────────────────┐
│    Express Server (server.mjs)      │
├─────────────────────────────────────┤
│ • POST /api/batch (Submit batch)    │
│ • POST /webhooks/wavespeed (Async)  │
│ • GET /status/:runId (Check status) │
│ • GET /health (Health check)        │
└─────────────────────────────────────┘
         │                    │
         v                    v
┌──────────────────┐  ┌──────────────────┐
│ WaveSpeed API    │  │ Airtable API     │
│ (Image Gen)      │  │ (Archive Results)│
└──────────────────┘  └──────────────────┘
```

## 🔧 Установка

### 1. Клонирование и зависимости

```bash
# Клонируй репозиторий (или создай новый проект)
git clone https://github.com/YOUR_USERNAME/wavespeed-batch-gen.git
cd wavespeed-batch-gen

# Установи зависимости
npm install express node-fetch form-data dotenv
```

### 2. Файл .env

Создай файл `.env` в корне проекта:

```env
# Server Configuration
PORT=3000
PUBLIC_BASE_URL=https://YOUR_DOMAIN.com

# WaveSpeed API
WAVESPEED_API_KEY=your_wavespeed_api_key_here

# Airtable Configuration
AIRTABLE_TOKEN=patXXXXXXXXXXXXXX
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
AIRTABLE_TABLE=Generations
```

### 3. Получение API ключей

#### WaveSpeed API Key
1. Перейди на https://wavespeed.ai
2. Зарегистрируйся и создай API ключ
3. Скопируй в переменную окружения

#### Airtable Token & Base ID
1. Открой https://airtable.com/api
2. Создай Personal Access Token
3. Скопируй в переменную `AIRTABLE_TOKEN`
4. Найди Base ID в URL: `https://airtable.com/BASE_ID/...`
5. Убедись, что у тебя есть таблица "Generations" с нужными полями (см. ниже)

### 4. Создание таблицы Airtable

Создай таблицу "Generations" со следующими полями:

| Field Name | Type | Description |
|------------|------|-------------|
| Prompt | Single line text | Основной промпт |
| Subject | Attachment | Основное изображение |
| References | Attachment | Референсные изображения |
| Output | Attachment | Выходные изображения (множественные) |
| Output URL | URL | URL первого выходного изображения |
| Model | Single line text | Модель (WaveSpeed Seedream v4.5) |
| Size | Single line text | Размер (WIDTHxHEIGHT) |
| Request IDs | Long text | Все ID заданий (через запятую) |
| Seen IDs | Long text | Обработанные IDs |
| Failed IDs | Long text | Неудачные IDs |
| Status | Single select | processing / completed / failed |
| Run ID | Single line text | Уникальный ID батча |
| Created At | Date | Дата создания |
| Last Update | Date | Последнее обновление |
| Completed At | Date | Дата завершения |

## 🚀 Развертывание на Render

### 1. Подготовка GitHub репозитория

```bash
# Инициализируй Git (если еще не сделано)
git init
git add .
git commit -m "Initial commit: WaveSpeed batch generator"

# Создай репо на GitHub и загрузи
git remote add origin https://github.com/YOUR_USERNAME/wavespeed-batch-gen.git
git branch -M main
git push -u origin main
```

### 2. Создание приложения на Render

1. Перейди на https://render.com
2. Нажми "New +" → "Web Service"
3. Подключи свой GitHub репозиторий
4. Заполни настройки:
   - **Name**: wavespeed-batch-gen
   - **Region**: Frankfurt (или ближайший к тебе)
   - **Branch**: main
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.mjs`

### 3. Переменные окружения на Render

На странице сервиса перейди в "Environment" и добавь:

```
PORT=3000
PUBLIC_BASE_URL=https://wavespeed-batch-gen.onrender.com
WAVESPEED_API_KEY=<your_key>
AIRTABLE_TOKEN=<your_token>
AIRTABLE_BASE_ID=<your_base_id>
AIRTABLE_TABLE=Generations
```

### 4. Deploy

Нажми "Create Web Service" — Render автоматически начнет деплой.

Как только статус = "Live", приложение будет доступно по адресу:
`https://wavespeed-batch-gen.onrender.com/app`

## 📱 Использование

### 1. Открой веб-интерфейс

```
https://YOUR_DOMAIN/app
```

### 2. Заполни форму

- **Prompt**: Детальное описание того, что хочешь сгенерировать
- **Subject Image URL**: URL основного изображения (может быть PNG, JPG)
- **Reference Image URLs**: Опционально, через запятую
- **Width/Height**: 256-2048 пиксели
- **Batch Count**: 1-10 изображений

### 3. Нажми "Start Batch Generation"

Сервер:
1. Преобразует изображения в base64
2. Создает родительскую запись в Airtable
3. Отправляет задания на WaveSpeed API (с 1.2s паузой между ними)
4. Начинает опрашивать результаты каждые 7 секунд
5. При завершении добавляет изображения в Airtable

### 4. Проверь статус

```bash
# Получи статус батча
curl https://YOUR_DOMAIN/status/run-XXXXXXX
```

Ответ:

```json
{
  "runId": "run-1702424100000-abc123",
  "status": "completed",
  "totalTasks": 3,
  "completedTasks": 3,
  "failedTasks": 0,
  "requestIds": ["req-1", "req-2", "req-3"],
  "seenIds": ["req-1", "req-2", "req-3"],
  "failedIds": [],
  "elapsedSeconds": 145
}
```

## 🔄 Как это работает

### Жизненный цикл задания

```
1. User submits form
   ↓
2. Server creates parent Airtable record
   ↓
3. For each task in batch:
   a) Convert images to base64
   b) Submit to WaveSpeed API
   c) Add Request ID to Airtable
   d) Wait 1.2 seconds
   ↓
4. For each submitted task:
   a) Polling every 7 seconds
   b) Check status on WaveSpeed
   c) If completed: add images to Airtable
   d) If failed: mark as failed
   e) If timeout after 20min: mark as failed
   ↓
5. When all tasks seen:
   a) Update Airtable record Status = completed
   b) Add all output images
   c) Update timestamps
```

### Обработка ошибок

- **Network timeout**: Retry с exponential backoff
- **API error**: Помечается как failed, батч продолжает работу
- **Long tasks**: До 20 минут опроса, затем timeout
- **Stuck tasks**: Никогда не остаются в "processing" — либо completed, либо failed

## 🔐 Безопасность

- API ключи хранятся в переменных окружения (никогда не в коде)
- Вебхук проверяет наличие задания в `jobStore`
- Изображения конвертируются в base64 перед отправкой
- CORS не включен (для максимальной безопасности)

## 📊 Мониторинг

### Health Check

```bash
curl https://YOUR_DOMAIN/health
```

### Логирование

Сервер выводит подробные логи для каждого шага:

```
[Batch Start] Run run-XXX: Starting 3 tasks
[Airtable] Created parent record: recXXX
[Submission] Run run-XXX: Task 1/3 submitted as req-XXX
[Polling] Task req-XXX: processing
[Polling] Task req-XXX: completed
[Completion] Task req-XXX marked as completed
[Airtable] Record recXXX updated
[Batch Complete] Run run-XXX: All tasks processed
```

## 🐛 Troubleshooting

### "Missing required fields" (400)
- Проверь, что все обязательные поля заполнены
- Проверь формат JSON в POST запросе

### "Failed to fetch image" (500)
- Убедись, что URL изображения доступен
- Проверь, что сервер может скачивать с этого домена
- Попробуй использовать HTTPS

### "Airtable create error" (500)
- Проверь, что AIRTABLE_TOKEN и AIRTABLE_BASE_ID правильные
- Проверь, что таблица "Generations" существует
- Проверь, что все необходимые поля существуют

### Задания застряли в "processing"
- Обычно разрешается за 20 минут опроса
- Проверь логи сервера
- Перезагрузи сервер

### Вебхук не приходит
- Проверь, что PUBLIC_BASE_URL правильный
- Убедись, что сервер доступен по этому URL
- WaveSpeed может запаздывать с вебхуками — опрос работает как fallback

## 📈 Оптимизация

### Скорость генерации
- Минимум 1.2s между заданиями (из-за rate limiting WaveSpeed)
- Каждое задание обрабатывается параллельно

### Стоимость
- WaveSpeed начисляет кредиты за каждое сгенерированное изображение
- Размер 512x512: 40 кредитов
- Размер 1024x1024: 160 кредитов

### Масштабирование
- Сервер может одновременно обрабатывать сотни батчей
- Каждый батч занимает мало памяти (всего метаданные в Map)
- Для продакшена рассмотри Redis для хранения состояния

## 📚 API Reference

### POST /api/batch

Отправить батч заданий

**Request:**
```json
{
  "prompt": "A beautiful landscape...",
  "subjectUrl": "https://example.com/image.jpg",
  "referenceUrls": ["https://example.com/ref1.jpg"],
  "width": 512,
  "height": 512,
  "batchCount": 3
}
```

**Response (200):**
```json
{
  "runId": "run-1702424100000-abc123",
  "parentId": "recXXXXXXXX",
  "message": "Batch submitted successfully"
}
```

### GET /status/:runId

Получить статус батча

**Response (200):**
```json
{
  "runId": "run-1702424100000-abc123",
  "status": "processing|completed|failed",
  "prompt": "...",
  "totalTasks": 3,
  "completedTasks": 2,
  "failedTasks": 0,
  "requestIds": ["req-1", "req-2", "req-3"],
  "seenIds": ["req-1", "req-2"],
  "failedIds": [],
  "startTime": 1702424100000,
  "elapsedSeconds": 145
}
```

### POST /webhooks/wavespeed

Вебхук для получения результатов от WaveSpeed (внутренний)

### GET /health

Проверка здоровья сервера

**Response (200):**
```json
{
  "status": "ok",
  "timestamp": "2024-12-12T09:00:00.000Z",
  "uptime": 3600.5
}
```

## 🎓 Примеры использования

### cURL

```bash
# Отправить батч
curl -X POST https://your-domain.com/api/batch \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Cinematic shot of a futuristic city",
    "subjectUrl": "https://example.com/city.jpg",
    "referenceUrls": [],
    "width": 512,
    "height": 512,
    "batchCount": 3
  }'

# Проверить статус
curl https://your-domain.com/status/run-1702424100000-abc123
```

### JavaScript (fetch)

```javascript
const response = await fetch('https://your-domain.com/api/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Your prompt here',
    subjectUrl: 'https://example.com/image.jpg',
    referenceUrls: [],
    width: 512,
    height: 512,
    batchCount: 3
  })
});

const { runId, parentId } = await response.json();
console.log(`Batch started: ${runId}`);
```

## 🤝 Support

Если возникнут проблемы:
1. Проверь логи сервера (`console.log` на Render)
2. Убедись, что все переменные окружения установлены
3. Проверь, что API ключи валидны
4. Посмотри status endpoint для деталей

---

**Создано для максимальной надежности и автоматизации. Наслаждайся! 🚀**
