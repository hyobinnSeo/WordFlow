require('dotenv').config();
const express = require('express');
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

// Create API clients
let client;
let genAI;
let translate;
let openai;
try {
    // Set credentials using single API key file
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow.json');
    client = new speech.SpeechClient();
    translate = new Translate();
    
    // Initialize Gemini API with the API key
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
        throw new Error('Please set your Gemini API key in the .env file');
    }
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

    // Initialize OpenAI API
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY || OPENAI_API_KEY === 'your_openai_api_key_here') {
        throw new Error('Please set your OpenAI API key in the .env file');
    }
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    
    console.log('Successfully initialized API clients');
} catch (error) {
    console.error('Error initializing clients:', error);
}

// Translation function using Google Cloud Translation API
async function translateWithGoogle(text) {
    try {
        const [translation] = await translate.translate(text, 'ko');
        return translation;
    } catch (error) {
        console.error('Google Translation error:', error);
        throw error;
    }
}

// Translation function using Gemini Flash API
async function translateWithGeminiFlash(text, context = '') {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite-preview-02-05" });
        
        // Add delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const prompt = `[Instructions]

You are a professional translator specializing in English to Korean translation. Your task is to translate the provided English text to Korean, focusing only on the given text.

The input text may contain:
Spelling errors or homophones
Grammatically incomplete fragments
Ambiguous meanings

- If there are no issues, please provide only the Korean translation without any explanations or commentary.
- If issues are detected, use this format:
{Direct Korean translation}
[Issue: {Brief description of the potential problem in Korean}]
[Alternative: {Your suggested alternative Korean translation based on the context}]
The most common issue: If the sentence fragment appears to be part of a previous sentence:
1. Keep track of all fragments to reconstruct the complete sentence.
2. When the final fragment is detected, provide: A complete, natural translation of the entire reconstructed sentence.
NOTE: Provide a natural, conversational Korean translation.

Context:
${context.slice(0, 1000)}

Text to be translated:
"${text}"`;
        
        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const translation = response.text().trim();
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
async function translateWithGPT(text, context = '') {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `[Instructions]

You are a professional translator specializing in English to Korean translation. Your task is to translate the provided English text to Korean, focusing only on the given text.

The input text may contain:
Spelling errors or homophones
Grammatically incomplete fragments
Ambiguous meanings

- If there are no issues, please provide only the Korean translation without any explanations or commentary.
- If issues are detected, use this format:
{Direct Korean translation}
[Issue: {Brief description of the potential problem in Korean}]
[Alternative: {Your suggested alternative Korean translation based on the context}]
The most common issue: If the sentence fragment appears to be part of a previous sentence:
1. Keep track of all fragments to reconstruct the complete sentence.
2. When the final fragment is detected, provide: A complete, natural translation of the entire reconstructed sentence.
NOTE: Provide a natural, conversational Korean translation.`
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

        return response.choices[0].message.content.trim();
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
                break;
                
            case 'openai':
                const tempOpenAI = new OpenAI({ apiKey: key });
                await tempOpenAI.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [{ role: "user", content: "Test" }]
                });
                break;
                
            case 'gcp':
                const credentials = JSON.parse(key);
                // Format private key
                const cleanKey = credentials.privateKey
                    .replace(/\\n/g, '\n')
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
                    .replace(/-----END PRIVATE KEY-----/g, '')
                    .replace(/\s/g, '');

                // Format key in proper PEM format
                const formattedPrivateKey = [
                    '-----BEGIN PRIVATE KEY-----',
                    ...cleanKey.match(/.{1,64}/g) || [],
                    '-----END PRIVATE KEY-----'
                ].join('\n');
                
                const tempTranslate = new Translate({
                    projectId: credentials.projectId,
                    credentials: {
                        client_email: credentials.clientEmail,
                        private_key: formattedPrivateKey
                    }
                });
                await tempTranslate.translate("Test", 'ko');
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
    
    let recognizeStream = null;
    let isStreamActive = false;
    let streamRestartTimeout;
    let totalDurationTimeout;
    const STREAM_TIMEOUT = 240000; // 4 minutes in milliseconds (safe margin before 305 seconds limit)
    const TOTAL_DURATION_LIMIT = 7200000; // 2 hours in milliseconds

    // Function to create a new recognize stream
    const createRecognizeStream = () => {
        // Using single API key file for speech-to-text
        process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow.json');
        
        console.log('Starting new recognize stream...');
        
        const request = {
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 16000,
                languageCode: 'en-US',
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
    socket.on('requestTranslation', async (data) => {
        try {
            let translatedText;
            switch (data.service) {
                case 'google':
                    translatedText = await translateWithGoogle(data.text);
                    break;
                case 'gemini-flash':
                    translatedText = await translateWithGeminiFlash(data.text, data.context || '');
                    break;
                case 'gpt-mini':
                    translatedText = await translateWithGPT(data.text, data.context || '');
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
