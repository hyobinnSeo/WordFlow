const express = require('express');
const fs = require('fs');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});
const speech = require('@google-cloud/speech');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Translate } = require('@google-cloud/translate').v2;
const OpenAI = require('openai');

// Serve static files from public directory
app.use(express.static('public'));

// Load API keys from json file
const loadApiKeys = () => {
    try {
        const keysPath = path.join(__dirname, 'keys', 'api-keys.json');
        const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
        return keys;
    } catch (error) {
        console.error('Error loading API keys:', error);
        return { openai: null, gemini: null, gcp: null };
    }
};

// Initialize API clients
let client = null;
let genAI = null;
let translate = null;
let openai = null;

// Function to initialize clients with verified keys
const initializeClients = () => {
    try {
        const apiKeys = loadApiKeys();
        
        // Initialize Gemini API if key exists
        if (apiKeys.gemini) {
            genAI = new GoogleGenerativeAI(apiKeys.gemini);
        }

        // Initialize OpenAI API if key exists
        if (apiKeys.openai) {
            openai = new OpenAI({ apiKey: apiKeys.openai });
        }
        
        // Initialize Google Cloud clients if credentials exist
        const gcpCredentialsPath = path.join(__dirname, 'keys', 'voiceflow.json');
        if (fs.existsSync(gcpCredentialsPath)) {
            process.env.GOOGLE_APPLICATION_CREDENTIALS = gcpCredentialsPath;
            client = new speech.SpeechClient();
            translate = new Translate();
        }
        
        console.log('Successfully initialized available API clients');
    } catch (error) {
        console.error('Error initializing clients:', error);
    }
};

// Initial client initialization
initializeClients();

// Default prompts
const DEFAULT_PROMPTS = {
    gemini: `You are a professional translator who specializes in natural and fluent translations. Your task is to translate the given text from source language to target language.

The input text may contain:
Spelling errors or homophones
Grammatically incomplete fragments
Ambiguous meanings

1. If issues are detected, use this format:
Direct translation
[Issue: Brief description of the potential problem in target language]
[Alternative: Your suggested alternative target language translation based on the context]
2. If the given sentence appears to be part of a previous sentence, follow this instructions.
- Keep track of all fragments to reconstruct the complete sentence.
- When the final fragment is detected, use this format:
[Issue: ]
[Completed translation: A complete, natural target language translation of the entire reconstructed sentence]
3. If there are no issues, no fragments, please provide only the translation without any explanations or commentary.`,
    openai: `You are a professional translator who specializes in natural and fluent translations. Your task is to translate the given text from source language to target language.

The input text may contain:
Spelling errors or homophones
Grammatically incomplete fragments
Ambiguous meanings

1. If issues are detected, use this format:
Direct translation
[Issue: Brief description of the potential problem in target language]
[Alternative: Your suggested alternative target language translation based on the context]
2. If the given sentence appears to be part of a previous sentence, follow this instructions.
- Keep track of all fragments to reconstruct the complete sentence.
- When the final fragment is detected, use this format:
[Issue: ]
[Completed translation: A complete, natural target language translation of the entire reconstructed sentence]
3. If there are no issues, no fragments, please provide only the translation without any explanations or commentary.`
};

// Current prompts
let currentPrompts = { ...DEFAULT_PROMPTS };

// Translation function using Gemini Flash API
async function translateWithGeminiFlash(text, context = '', customPrompt = '', sourceLanguage = 'English', targetLanguage = 'Korean') {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        // Add delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const prompt = `[Instructions]

${(customPrompt || currentPrompts.gemini).replace(/source language/g, sourceLanguage).replace(/target language/g, targetLanguage)}

Context:
${context.slice(0, 1000)}

Text to be translated:
${text}`;
        
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const translation = response.text().trim().replace(/^"(.*)"$/, '$1');
            return translation;
        } catch (error) {
            if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                // If rate limited, wait longer and retry once
                await new Promise(resolve => setTimeout(resolve, 2000));
                const retryResult = await model.generateContent(prompt);
                const retryResponse = await retryResult.response;
                return retryResponse.text().trim();
            }
            throw error;
        }
    } catch (error) {
        console.error('Gemini Translation error:', error);
        throw error;
    }
}

// Translation function using GPT-4o-mini
async function translateWithGPT(text, context = '', customPrompt = '', sourceLanguage = 'English', targetLanguage = 'Korean') {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `[Instructions]

${(customPrompt || currentPrompts.openai).replace(/source language/g, sourceLanguage).replace(/target language/g, targetLanguage)}`
                },
                {
                    role: "user",
                    content: `Context:
${context.slice(0, 1000)}

Text to be translated:
${text}`
                }
            ],
            temperature: 0.3
        });

        return response.choices[0].message.content.trim().replace(/^"(.*)"$/, '$1');
    } catch (error) {
        console.error('GPT Translation error:', error);
        throw error;
    }
}

// Add JSON parsing middleware
app.use(express.json());

// API key verification endpoint
app.post('/verify-api-key', async (req, res) => {
    const { service, key } = req.body;
    
    try {
        switch (service) {
            case 'gemini':
                const tempGenAI = new GoogleGenerativeAI(key);
                const model = tempGenAI.getGenerativeModel({ model: "gemini-2.0-flash-lite-preview-02-05" });
                await model.generateContent("Test"); // Verify key works
                
                // Ensure keys directory exists
                const keysDir = path.join(__dirname, 'keys');
                if (!fs.existsSync(keysDir)) {
                    fs.mkdirSync(keysDir, { recursive: true });
                }

                // Save verified key to api-keys.json
                const apiKeys = loadApiKeys();
                apiKeys.gemini = key;
                const keysPath = path.join(keysDir, 'api-keys.json');
                fs.writeFileSync(keysPath, JSON.stringify(apiKeys, null, 2));
                
                // Reinitialize clients
                initializeClients();
                break;
                
            case 'openai':
                // Validate OpenAI key format
                if (!key.startsWith('sk-')) {
                    throw new Error('Invalid OpenAI API key format. Please use an API key that starts with "sk-"');
                }
                
                const tempOpenAI = new OpenAI({ apiKey: key });
                await tempOpenAI.chat.completions.create({
                    model: "gpt-3.5-turbo", // Use a standard model for verification
                    messages: [{ role: "user", content: "Test" }]
                });
                
                // Ensure keys directory exists
                const openaiKeysDir = path.join(__dirname, 'keys');
                if (!fs.existsSync(openaiKeysDir)) {
                    fs.mkdirSync(openaiKeysDir, { recursive: true });
                }

                // Save verified key to api-keys.json
                const openaiKeys = loadApiKeys();
                openaiKeys.openai = key;
                const openaiKeysPath = path.join(openaiKeysDir, 'api-keys.json');
                fs.writeFileSync(openaiKeysPath, JSON.stringify(openaiKeys, null, 2));
                
                // Reinitialize clients
                initializeClients();
                break;
                
            case 'gcp':
                const credentials = JSON.parse(key);
                
                // Convert frontend field names to expected format
                const formattedInput = {
                    project_id: credentials.projectId || credentials['Project ID'],
                    client_email: credentials.clientEmail || credentials['Client Email'],
                    private_key: credentials.privateKey || credentials['Private Key']
                };

                // Validate required GCP fields
                if (!formattedInput.project_id || !formattedInput.private_key || !formattedInput.client_email) {
                    throw new Error('Invalid GCP credentials format. Missing required fields (Project ID, Private Key, Client Email)');
                }
                
                // Format private key if needed
                let privateKey = formattedInput.private_key;
                if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                    const cleanKey = privateKey
                        .replace(/\\n/g, '\n')
                        .replace(/\r\n/g, '\n')
                        .replace(/\r/g, '\n')
                        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
                        .replace(/-----END PRIVATE KEY-----/g, '')
                        .replace(/\s/g, '');

                    privateKey = [
                        '-----BEGIN PRIVATE KEY-----',
                        ...cleanKey.match(/.{1,64}/g) || [],
                        '-----END PRIVATE KEY-----'
                    ].join('\n');
                }
                
                // Create properly formatted credentials object
                const formattedCredentials = {
                    type: 'service_account',
                    project_id: formattedInput.project_id,
                    private_key: privateKey,
                    client_email: formattedInput.client_email
                };
                
                // Test the credentials
                const tempTranslate = new Translate({
                    projectId: formattedCredentials.project_id,
                    credentials: {
                        client_email: formattedCredentials.client_email,
                        private_key: formattedCredentials.private_key
                    }
                });
                await tempTranslate.translate("Test", 'ko');
                
                // Ensure keys directory exists
                const gcpKeysDir = path.join(__dirname, 'keys');
                if (!fs.existsSync(gcpKeysDir)) {
                    fs.mkdirSync(gcpKeysDir, { recursive: true });
                }

                // If verification successful, save formatted credentials to voiceflow.json
                const voiceflowPath = path.join(gcpKeysDir, 'voiceflow.json');
                fs.writeFileSync(voiceflowPath, JSON.stringify(formattedCredentials, null, 2));
                
                // Reinitialize clients with new credentials
                initializeClients();
                break;
                
            default:
                throw new Error('Invalid service');
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error(`Error verifying ${service} API key:`, error);
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Basic route for testing
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Initialize socket with default language settings
    socket.sourceLanguage = 'en-US';
    socket.targetLanguage = 'ko';
    
    let recognizeStream = null;
    let isStreamActive = false;
    let streamRestartTimeout;
    let totalDurationTimeout;
    const STREAM_TIMEOUT = 240000; // 4 minutes in milliseconds (safe margin before 305 seconds limit)
    const TOTAL_DURATION_LIMIT = 7200000; // 2 hours in milliseconds

    // Function to create a new recognize stream
    const createRecognizeStream = () => {
        // Check if GCP credentials exist
        const gcpCredentialsPath = path.join(__dirname, 'keys', 'voiceflow.json');
        if (!fs.existsSync(gcpCredentialsPath)) {
            throw new Error('Google Cloud credentials not found. Please verify your GCP key in settings.');
        }
        process.env.GOOGLE_APPLICATION_CREDENTIALS = gcpCredentialsPath;
        
        console.log('Starting new recognize stream...');
        
        const request = {
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 16000,
                languageCode: socket.sourceLanguage || 'en-US',
                enableAutomaticPunctuation: true,
                model: 'default',
                useEnhanced: true,
                metadata: {
                    interactionType: 'DICTATION',
                    microphoneDistance: 'NEARFIELD',
                    recordingDeviceType: 'PC_MIC',
                }
            },
            interimResults: true
        };

        recognizeStream = client
            .streamingRecognize(request)
            .on('error', (error) => {
                console.error('Error in recognize stream:', error);
                socket.emit('error', 'Speech recognition error occurred: ' + error.message);
                
                // Only restart if it's the timeout error and streaming is still meant to be active
                if (error.code === 11 && isStreamActive) {
                    console.log('Stream timed out, restarting...');
                    createRecognizeStream();
                } else {
                    isStreamActive = false;
                }
            })
            .on('data', async (data) => {
                if (data.results[0] && data.results[0].alternatives[0]) {
                    const transcript = data.results[0].alternatives[0].transcript;
                    const isFinal = data.results[0].isFinal;
                    
                    socket.emit('transcription', {
                        text: transcript,
                        isFinal: isFinal
                    });
                }
            })
            .on('end', () => {
                console.log('Recognize stream ended');
            });

        // Set up automatic stream restart before timeout
        clearTimeout(streamRestartTimeout);
        streamRestartTimeout = setTimeout(() => {
            if (isStreamActive) {
                console.log('Preemptively restarting stream before timeout...');
                const oldStream = recognizeStream;
                createRecognizeStream(); // Create new stream first
                oldStream.end(); // Then end the old stream
            }
        }, STREAM_TIMEOUT);

        return recognizeStream;
    };

    // Function to stop recording
    const stopRecording = (reason) => {
        if (recognizeStream && isStreamActive) {
            isStreamActive = false;
            clearTimeout(streamRestartTimeout);
            clearTimeout(totalDurationTimeout);
            recognizeStream.end();
            socket.emit('recordingStopped', { reason: reason });
            console.log('Recording stopped:', reason);
        }
    };

    // Handle translation requests
    // Store API keys
    let apiKeys = {
        openai: null,
        gemini: null,
        gcp: null
    };

    socket.on('updateApiKeys', (data) => {
        apiKeys = { ...apiKeys, ...data };
        if (data.prompts) {
            currentPrompts = { ...currentPrompts, ...data.prompts };
        }
        if (data.sourceLanguage) {
            socket.sourceLanguage = data.sourceLanguage;
        }
        if (data.targetLanguage) {
            socket.targetLanguage = data.targetLanguage;
        }
    });

    socket.on('requestTranslation', async (data) => {
        try {
            let translatedText;
            switch (data.service) {
                case 'google':
                    if (!translate) {
                        throw new Error('Google Cloud Translation not initialized. Please verify your GCP credentials in settings.');
                    }
                    const [translation] = await translate.translate(data.text, data.targetLanguage || 'ko');
                    translatedText = translation;
                    break;
                case 'gemini-flash':
                    if (!genAI) {
                        throw new Error('Gemini API not initialized. Please verify your Gemini API key in settings.');
                    }
                    translatedText = await translateWithGeminiFlash(
                        data.text, 
                        data.context || '', 
                        currentPrompts.gemini,
                        data.sourceLanguage || 'English',
                        data.targetLanguage || 'Korean'
                    );
                    break;
                case 'gpt-mini':
                    if (!openai) {
                        throw new Error('OpenAI API not initialized. Please verify your OpenAI API key in settings.');
                    }
                    translatedText = await translateWithGPT(
                        data.text, 
                        data.context || '', 
                        currentPrompts.openai,
                        data.sourceLanguage || 'English',
                        data.targetLanguage || 'Korean'
                    );
                    break;
                default:
                    throw new Error('Invalid translation service selected');
            }
            
            socket.emit('translation', {
                original: data.text,
                translated: translatedText
            });
        } catch (error) {
            socket.emit('error', 'Translation error: ' + error.message);
        }
    });

    socket.on('startGoogleCloudStream', async () => {
        try {
            isStreamActive = true;
            createRecognizeStream();
            console.log('Successfully created recognize stream');

            // Set up total duration limit
            clearTimeout(totalDurationTimeout);
            totalDurationTimeout = setTimeout(() => {
                stopRecording('Recording limit of 2 hours reached');
            }, TOTAL_DURATION_LIMIT);

        } catch (error) {
            console.error('Error creating recognize stream:', error);
            socket.emit('error', 'Failed to start speech recognition: ' + error.message);
            isStreamActive = false;
        }
    });

    socket.on('audioData', (data) => {
        if (recognizeStream && isStreamActive && !recognizeStream.destroyed && recognizeStream.writable) {
            try {
                const buffer = Buffer.from(data);
                recognizeStream.write(buffer);
            } catch (error) {
                console.error('Error writing to recognize stream:', error);
                socket.emit('error', 'Error processing audio: ' + error.message);
                isStreamActive = false;
            }
        }
    });

    socket.on('endGoogleCloudStream', () => {
        stopRecording('Recording manually stopped');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        stopRecording('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
