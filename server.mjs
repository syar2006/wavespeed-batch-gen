import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Configuration
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Generations';

const WAVESPEED_API_URL = 'https://api.wavespeed.ai/api/v3/bytedance/seedream-v4.5/edit';
const WAVESPEED_RESULT_URL = 'https://api.wavespeed.ai/api/v3/predictions';
const AIRTABLE_API_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`;

// In-memory store for tracking batches and jobs
const batchStore = new Map(); // runId -> { parentId, requestIds[], seenIds[], failedIds[], status, startTime }
const jobStore = new Map(); // requestId -> { runId, parentId, status, retries }

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Converts image URL to base64 data URL
 */
async function urlToBase64DataUrl(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    const buffer = await response.buffer();
    const base64 = buffer.toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    console.error(`Error converting URL to base64: ${imageUrl}`, error);
    throw error;
  }
}

/**
 * Submit a single task to WaveSpeed API
 */
async function submitWaveSpeedTask(prompt, subjectImageB64, referenceImagesB64, width, height, batchIndex) {
  const images = [
    { image: subjectImageB64, type: 'subject' },
    ...referenceImagesB64.map(img => ({ image: img, type: 'reference' }))
  ];

  const payload = {
    prompt,
    images,
    width: parseInt(width),
    height: parseInt(height),
    num_inference_steps: 30,
    guidance_scale: 7.5,
    enable_base64_output: true,
    webhook: `${PUBLIC_BASE_URL}/webhooks/wavespeed`
  };

  const response = await fetch(WAVESPEED_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WAVESPEED_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WaveSpeed API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  return result.data.id; // requestId
}

/**
 * Poll WaveSpeed API until task is done (with exponential backoff)
 */
async function pollUntilDone(requestId, parentId, runId, maxRetries = 170, initialDelayMs = 7000) {
  let retries = 0;
  let delayMs = initialDelayMs;

  while (retries < maxRetries) {
    try {
      const response = await fetch(`${WAVESPEED_RESULT_URL}/${requestId}/result`, {
        headers: {
          'Authorization': `Bearer ${WAVESPEED_API_KEY}`
        }
      });

      if (!response.ok) {
        throw new Error(`Polling error: ${response.status}`);
      }

      const result = await response.json();
      const data = result.data;

      console.log(`[Polling] Task ${requestId}: ${data.status}`);

      if (data.status === 'completed') {
        // Task completed successfully
        await handleTaskCompletion(requestId, parentId, runId, data);
        return true;
      } else if (data.status === 'failed') {
        // Task failed
        await handleTaskFailure(requestId, parentId, runId);
        return false;
      } else if (data.status === 'processing' || data.status === 'created') {
        // Still processing, continue polling
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 1.1, 15000); // Exponential backoff, max 15s
        retries++;
      }
    } catch (error) {
      console.error(`[Polling Error] Task ${requestId}:`, error);
      // Retry on network errors
      if (retries < maxRetries - 1) {
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 1.1, 15000);
        retries++;
      } else {
        // Max retries reached, mark as failed
        await handleTaskFailure(requestId, parentId, runId);
        return false;
      }
    }
  }

  // Timeout reached
  console.warn(`[Timeout] Task ${requestId} did not complete within ${maxRetries * 7}s`);
  await handleTaskFailure(requestId, parentId, runId);
  return false;
}

/**
 * Handle successful task completion
 */
async function handleTaskCompletion(requestId, parentId, runId, taskData) {
  const batch = batchStore.get(runId);
  if (!batch) return;

  // Extract images from task output
  if (taskData.output && taskData.output.length > 0) {
    // Download images and prepare for Airtable attachment
    const attachments = [];
    for (let i = 0; i < taskData.output.length; i++) {
      const imageUrl = taskData.output[i];
      attachments.push({ url: imageUrl });
    }

    batch.outputImages = batch.outputImages || [];
    batch.outputImages.push(...attachments);
  }

  batch.seenIds.push(requestId);
  jobStore.get(requestId).status = 'completed';

  console.log(`[Completion] Task ${requestId} marked as completed`);

  // Check if all tasks are done
  await checkBatchCompletion(runId, parentId);
}

/**
 * Handle task failure
 */
async function handleTaskFailure(requestId, parentId, runId) {
  const batch = batchStore.get(runId);
  if (!batch) return;

  batch.failedIds.push(requestId);
  batch.seenIds.push(requestId);
  jobStore.get(requestId).status = 'failed';

  console.log(`[Failure] Task ${requestId} marked as failed`);

  // Check if all tasks are seen
  await checkBatchCompletion(runId, parentId);
}

/**
 * Check if batch is complete (all tasks seen)
 */
async function checkBatchCompletion(runId, parentId) {
  const batch = batchStore.get(runId);
  if (!batch) return;

  if (batch.seenIds.length === batch.requestIds.length) {
    // All tasks have been processed
    batch.status = 'completed';
    await updateAirtableRecord(parentId, batch);
    console.log(`[Batch Complete] Run ${runId}: All tasks processed`);
  }
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create parent record in Airtable
 */
async function createAirtableRecord(fields) {
  const response = await fetch(AIRTABLE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields,
      typecast: true
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Airtable create error: ${error}`);
  }

  const result = await response.json();
  return result.id;
}

/**
 * Update Airtable record with batch results
 */
async function updateAirtableRecord(recordId, batch) {
  const fieldsToUpdate = {
    'Request IDs': batch.requestIds.join(','),
    'Seen IDs': batch.seenIds.join(','),
    'Failed IDs': batch.failedIds.join(','),
    'Status': batch.failedIds.length > 0 ? 'completed' : 'completed',
    'Last Update': new Date().toISOString(),
    'Completed At': new Date().toISOString()
  };

  // Add output images as attachments if available
  if (batch.outputImages && batch.outputImages.length > 0) {
    fieldsToUpdate['Output'] = batch.outputImages;
    if (batch.outputImages.length > 0 && batch.outputImages[0].url) {
      fieldsToUpdate['Output URL'] = batch.outputImages[0].url;
    }
  }

  const response = await fetch(`${AIRTABLE_API_URL}/${recordId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fields: fieldsToUpdate,
      typecast: true
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Airtable update error for ${recordId}:`, error);
    throw new Error(`Airtable update error: ${error}`);
  }

  console.log(`[Airtable] Record ${recordId} updated`);
}

/**
 * Submit batch of tasks with retry logic
 */
async function submitBatch(runId, prompt, subjectImageUrl, referenceImageUrls, width, height, batchCount) {
  const batch = {
    requestIds: [],
    seenIds: [],
    failedIds: [],
    outputImages: [],
    status: 'processing',
    startTime: Date.now(),
    prompt,
    width: parseInt(width),
    height: parseInt(height),
    batchCount: parseInt(batchCount)
  };

  batchStore.set(runId, batch);

  console.log(`[Batch Start] Run ${runId}: Starting ${batchCount} tasks`);

  // Convert images to base64
  let subjectImageB64;
  let referenceImagesB64 = [];

  try {
    subjectImageB64 = await urlToBase64DataUrl(subjectImageUrl);
    for (const refUrl of referenceImageUrls) {
      const refB64 = await urlToBase64DataUrl(refUrl);
      referenceImagesB64.push(refB64);
    }
  } catch (error) {
    console.error(`[Batch Error] Run ${runId}: Failed to convert images to base64:`, error);
    return null;
  }

  // Create parent Airtable record
  let parentId;
  try {
    parentId = await createAirtableRecord({
      'Prompt': prompt,
      'Model': 'WaveSpeed Seedream v4.5',
      'Size': `${width}x${height}`,
      'Status': 'processing',
      'Run ID': runId,
      'Created At': new Date().toISOString(),
      'Last Update': new Date().toISOString(),
      'Request IDs': '',
      'Seen IDs': '',
      'Failed IDs': ''
    });
    console.log(`[Airtable] Created parent record: ${parentId}`);
  } catch (error) {
    console.error(`[Batch Error] Run ${runId}: Failed to create Airtable record:`, error);
    return null;
  }

  // Submit tasks
  for (let i = 0; i < batchCount; i++) {
    try {
      const requestId = await submitWaveSpeedTask(
        prompt,
        subjectImageB64,
        referenceImagesB64,
        width,
        height,
        i
      );

      batch.requestIds.push(requestId);
      jobStore.set(requestId, {
        runId,
        parentId,
        status: 'submitted',
        retries: 0
      });

      console.log(`[Submission] Run ${runId}: Task ${i + 1}/${batchCount} submitted as ${requestId}`);

      // Update Airtable with new request IDs
      await updateAirtableRecord(parentId, batch);

      // Pause between submissions to avoid rate limiting
      if (i < batchCount - 1) {
        await sleep(1200);
      }

      // Start polling for this task
      pollUntilDone(requestId, parentId, runId).catch(error => {
        console.error(`[Polling Error] Task ${requestId}:`, error);
      });

    } catch (error) {
      console.error(`[Submission Error] Run ${runId}: Task ${i + 1}/${batchCount}:`, error);
      // Mark task as failed immediately
      const failureId = `failed-${Date.now()}-${i}`;
      batch.failedIds.push(failureId);
      batch.seenIds.push(failureId);
    }
  }

  return parentId;
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * GET /app - Serve the UI form
 */
app.get('/app', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WaveSpeed Batch Generator</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
          max-width: 600px;
          width: 100%;
          padding: 40px;
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 28px;
        }
        .subtitle {
          color: #666;
          margin-bottom: 30px;
          font-size: 14px;
        }
        .form-group {
          margin-bottom: 24px;
        }
        label {
          display: block;
          color: #333;
          font-weight: 600;
          margin-bottom: 8px;
          font-size: 14px;
        }
        input[type="text"],
        input[type="number"],
        textarea {
          width: 100%;
          padding: 12px 16px;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          font-family: inherit;
          font-size: 14px;
          transition: border-color 0.3s;
        }
        input[type="text"]:focus,
        input[type="number"]:focus,
        textarea:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        textarea {
          resize: vertical;
          min-height: 100px;
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 13px;
        }
        .input-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .input-row.full {
          grid-template-columns: 1fr;
        }
        button {
          width: 100%;
          padding: 14px 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }
        button:active {
          transform: translateY(0);
        }
        button:disabled {
          opacity: 0.7;
          cursor: not-allowed;
          transform: none;
        }
        .message {
          margin-top: 20px;
          padding: 16px;
          border-radius: 8px;
          display: none;
          font-size: 14px;
        }
        .message.success {
          background: #d4edda;
          color: #155724;
          border: 1px solid #c3e6cb;
          display: block;
        }
        .message.error {
          background: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
          display: block;
        }
        .message.info {
          background: #d1ecf1;
          color: #0c5460;
          border: 1px solid #bee5eb;
          display: block;
        }
        .helper-text {
          font-size: 12px;
          color: #999;
          margin-top: 6px;
        }
        .loader {
          display: inline-block;
          width: 12px;
          height: 12px;
          border: 2px solid #f3f3f3;
          border-top: 2px solid #667eea;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-right: 8px;
          vertical-align: middle;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎨 WaveSpeed Batch Generator</h1>
        <p class="subtitle">Generate multiple images using Seedream v4.5</p>

        <form id="batchForm">
          <div class="form-group">
            <label for="prompt">Prompt *</label>
            <textarea id="prompt" name="prompt" placeholder="Describe what you want to generate..." required></textarea>
            <div class="helper-text">Detailed prompts produce better results</div>
          </div>

          <div class="form-group">
            <label for="subjectUrl">Subject Image URL *</label>
            <input type="text" id="subjectUrl" name="subjectUrl" placeholder="https://example.com/subject.jpg" required>
            <div class="helper-text">Primary image to be edited/referenced</div>
          </div>

          <div class="form-group">
            <label for="referenceUrls">Reference Image URLs (comma-separated)</label>
            <textarea id="referenceUrls" name="referenceUrls" placeholder="https://example.com/ref1.jpg, https://example.com/ref2.jpg"></textarea>
            <div class="helper-text">Optional: Additional reference images for style/composition</div>
          </div>

          <div class="form-group">
            <div class="input-row">
              <div>
                <label for="width">Width *</label>
                <input type="number" id="width" name="width" value="512" min="256" max="2048" required>
              </div>
              <div>
                <label for="height">Height *</label>
                <input type="number" id="height" name="height" value="512" min="256" max="2048" required>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label for="batchCount">Batch Count *</label>
            <input type="number" id="batchCount" name="batchCount" value="3" min="1" max="10" required>
            <div class="helper-text">Number of images to generate (1-10)</div>
          </div>

          <button type="submit" id="submitBtn">
            <span id="btnText">Start Batch Generation</span>
          </button>
        </form>

        <div id="message" class="message"></div>
      </div>

      <script>
        const form = document.getElementById('batchForm');
        const submitBtn = document.getElementById('submitBtn');
        const messageDiv = document.getElementById('message');
        const btnText = document.getElementById('btnText');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();

          const prompt = document.getElementById('prompt').value.trim();
          const subjectUrl = document.getElementById('subjectUrl').value.trim();
          const referenceUrls = document.getElementById('referenceUrls').value
            .split(',')
            .map(url => url.trim())
            .filter(url => url.length > 0);
          const width = document.getElementById('width').value;
          const height = document.getElementById('height').value;
          const batchCount = document.getElementById('batchCount').value;

          // Validation
          if (!prompt || !subjectUrl) {
            showMessage('Please fill in required fields', 'error');
            return;
          }

          submitBtn.disabled = true;
          btnText.innerHTML = '<span class="loader"></span>Submitting...';
          messageDiv.className = 'message';

          try {
            const response = await fetch('/api/batch', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                prompt,
                subjectUrl,
                referenceUrls,
                width,
                height,
                batchCount
              })
            });

            const data = await response.json();

            if (response.ok) {
              showMessage(
                \`✅ Batch submitted successfully!\\n\\nRun ID: \${data.runId}\\nAirtable Record: \${data.parentId}\\n\\nYour tasks are now processing. Check Airtable for results.\`,
                'success'
              );
              form.reset();
              document.getElementById('width').value = '512';
              document.getElementById('height').value = '512';
              document.getElementById('batchCount').value = '3';
            } else {
              showMessage(\`Error: \${data.error || 'Unknown error'}\`, 'error');
            }
          } catch (error) {
            showMessage(\`Error: \${error.message}\`, 'error');
          } finally {
            submitBtn.disabled = false;
            btnText.textContent = 'Start Batch Generation';
          }
        });

        function showMessage(text, type) {
          messageDiv.textContent = text;
          messageDiv.className = \`message \${type}\`;
          messageDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

/**
 * POST /api/batch - Submit a batch of tasks
 */
app.post('/api/batch', async (req, res) => {
  const { prompt, subjectUrl, referenceUrls = [], width, height, batchCount } = req.body;

  // Validation
  if (!prompt || !subjectUrl || !width || !height || !batchCount) {
    return res.status(400).json({
      error: 'Missing required fields: prompt, subjectUrl, width, height, batchCount'
    });
  }

  const runId = `run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    const parentId = await submitBatch(runId, prompt, subjectUrl, referenceUrls, width, height, batchCount);

    if (!parentId) {
      return res.status(500).json({ error: 'Failed to create batch' });
    }

    res.json({
      runId,
      parentId,
      message: 'Batch submitted successfully'
    });
  } catch (error) {
    console.error('Batch submission error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /webhooks/wavespeed - Webhook handler for WaveSpeed API
 */
app.post('/webhooks/wavespeed', async (req, res) => {
  const { id: requestId, status, output } = req.body;

  console.log(`[Webhook] Received notification for task ${requestId}: ${status}`);

  const job = jobStore.get(requestId);
  if (!job) {
    console.warn(`[Webhook] Unknown task: ${requestId}`);
    return res.status(404).json({ error: 'Task not found' });
  }

  try {
    if (status === 'completed' && output) {
      await handleTaskCompletion(requestId, job.parentId, job.runId, { output });
    } else if (status === 'failed') {
      await handleTaskFailure(requestId, job.parentId, job.runId);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Webhook Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /status/:runId - Get batch status
 */
app.get('/status/:runId', (req, res) => {
  const { runId } = req.params;
  const batch = batchStore.get(runId);

  if (!batch) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  res.json({
    runId,
    status: batch.status,
    prompt: batch.prompt,
    totalTasks: batch.requestIds.length,
    completedTasks: batch.seenIds.length,
    failedTasks: batch.failedIds.length,
    requestIds: batch.requestIds,
    seenIds: batch.seenIds,
    failedIds: batch.failedIds,
    startTime: batch.startTime,
    elapsedSeconds: Math.round((Date.now() - batch.startTime) / 1000)
  });
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         WaveSpeed Batch Generator Server Started           ║
╚════════════════════════════════════════════════════════════╝

📍 Server URL: http://localhost:${PORT}
🎨 Web UI: http://localhost:${PORT}/app
📊 Status: http://localhost:${PORT}/health

🔐 Configuration:
   - WaveSpeed API: ${WAVESPEED_API_KEY ? '✓ Configured' : '✗ Missing WAVESPEED_API_KEY'}
   - Airtable: ${AIRTABLE_TOKEN && AIRTABLE_BASE_ID ? '✓ Configured' : '✗ Missing credentials'}
   - Webhook Base URL: ${PUBLIC_BASE_URL}

⚠️  Make sure all env variables are set in .env file
  `);
});

export default app;
