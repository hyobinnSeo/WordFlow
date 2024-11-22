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
const {Translate} = require('@google-cloud/translate').v2;
const textToSpeech = require('@google-cloud/text-to-speech');
const path = require('path');

// Serve static files from public directory
app.use(express.static('public'));

// Create speech, translation, and TTS clients with error handling
let client;
let translate;
let ttsClient;
try {
    // Set credentials path for all services
    const keyPath = path.join(__dirname, 'keys', 'voiceflow-442410-e357e7554da8.json');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    
    // Initialize all clients
    client = new speech.SpeechClient();
    translate = new Translate();
    ttsClient = new textToSpeech.TextToSpeechClient();
    
    console.log('Successfully initialized Google Cloud clients');
} catch (error) {
    console.error('Error initializing Google Cloud clients:', error);
}

// Function to synthesize speech
async function synthesizeSpeech(text, targetLang) {
    try {
        let voiceConfig;
        if (targetLang === 'en') {
            voiceConfig = {
                name: 'en-US-Journey-F',
                languageCode: 'en-US',
                model: 'Journey'
            };
        } else if (targetLang === 'ko') {
            voiceConfig = {
                name: 'ko-KR-Neural2-C',
                languageCode: 'ko-KR',
                model: 'Neural2'
            };
        }

        const request = {
            input: { text: text },
            voice: voiceConfig,
            audioConfig: {
                audioEncoding: 'MP3'
            },
        };

        const [response] = await ttsClient.synthesizeSpeech(request);
        return response.audioContent;
    } catch (error) {
        console.error('TTS error:', error);
        throw error;
    }
}

// Detect language and translate text
async function detectAndTranslate(text) {
    try {
        // Detect the language
        const [detection] = await translate.detect(text);
        console.log('Detected language:', detection.language);
        
        // Determine target language based on detected language
        const targetLang = detection.language === 'ko' ? 'en' : 'ko';
        
        // Translate the text
        const [translation] = await translate.translate(text, targetLang);
        
        return {
            detectedLang: detection.language,
            targetLang,
            translation
        };
    } catch (error) {
        console.error('Translation error:', error);
        throw error;
    }
}

// Basic route for testing
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Function to create a new recognize stream
function createRecognizeStream(socket, primaryLanguage = 'en-US') {
    console.log('Starting new recognize stream with primary language:', primaryLanguage);
    
    // Set the alternative language based on primary language
    const alternativeLanguage = primaryLanguage.toLowerCase().startsWith('en') ? 'ko-KR' : 'en-US';
    
    const request = {
        config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: primaryLanguage,
            alternativeLanguageCodes: [alternativeLanguage],
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

    const recognizeStream = client
        .streamingRecognize(request)
        .on('error', (error) => {
            if (error.code === 11 || error.message.includes('exceeded')) {
                // Create new stream with opposite primary language
                if (socket.isStreamActive) {
                    const newPrimaryLang = primaryLanguage.toLowerCase().startsWith('en') ? 'ko-KR' : 'en-US';
                    socket.recognizeStream = createRecognizeStream(socket, newPrimaryLang);
                }
            } else {
                console.error('Error in recognize stream:', error);
                socket.emit('error', 'Speech recognition error occurred: ' + error.message);
            }
        })
        .on('data', async (data) => {
            if (data.results[0] && data.results[0].alternatives[0]) {
                const transcript = data.results[0].alternatives[0].transcript;
                const isFinal = data.results[0].isFinal;
                const detectedLanguage = data.results[0].languageCode;
                
                // Send original transcription
                socket.emit('transcription', {
                    text: transcript,
                    isFinal: isFinal,
                    languageCode: detectedLanguage
                });

                // If it's a final result, translate and generate TTS
                if (isFinal && socket.isStreamActive) {
                    try {
                        const result = await detectAndTranslate(transcript);
                        socket.emit('translation', {
                            original: transcript,
                            translated: result.translation,
                            fromLang: result.detectedLang,
                            toLang: result.targetLang
                        });

                        // Generate speech for the translation
                        try {
                            const audioContent = await synthesizeSpeech(result.translation, result.targetLang);
                            socket.emit('tts-audio', audioContent.toString('base64'));
                        } catch (error) {
                            console.error('TTS error:', error);
                            socket.emit('error', 'TTS error: ' + error.message);
                        }

                        // End current stream and create a new one with the detected language
                        if (socket.isStreamActive) {
                            recognizeStream.end();
                            // Use the exact detected language code for the new stream
                            socket.recognizeStream = createRecognizeStream(socket, detectedLanguage);
                        }
                    } catch (error) {
                        socket.emit('error', 'Translation error: ' + error.message);
                    }
                }
            }
        })
        .on('end', () => {
            console.log('Recognize stream ended');
        });

    return recognizeStream;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.recognizeStream = null;
    socket.isStreamActive = false;

    socket.on('startGoogleCloudStream', async () => {
        try {
            socket.isStreamActive = true;
            socket.recognizeStream = createRecognizeStream(socket);
            console.log('Successfully created recognize stream');
        } catch (error) {
            console.error('Error creating recognize stream:', error);
            socket.emit('error', 'Failed to start speech recognition: ' + error.message);
            socket.isStreamActive = false;
        }
    });

    socket.on('audioData', (data) => {
        // Check if stream exists and is writable
        if (socket.recognizeStream && socket.isStreamActive && !socket.recognizeStream.destroyed && socket.recognizeStream.writable) {
            try {
                // Convert the ArrayBuffer to Buffer
                const buffer = Buffer.from(data);
                socket.recognizeStream.write(buffer);
            } catch (error) {
                if (!error.message.includes('Audio Timeout Error')) {
                    console.error('Error writing to recognize stream:', error);
                    socket.emit('error', 'Error processing audio: ' + error.message);
                }
            }
        }
    });

    socket.on('endGoogleCloudStream', () => {
        if (socket.recognizeStream && socket.isStreamActive) {
            try {
                socket.isStreamActive = false;
                socket.recognizeStream.end();
                console.log('Successfully ended recognize stream');
            } catch (error) {
                console.error('Error ending recognize stream:', error);
                socket.emit('error', 'Error ending stream: ' + error.message);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        
        if (socket.recognizeStream && socket.isStreamActive) {
            try {
                socket.isStreamActive = false;
                socket.recognizeStream.end();
            } catch (error) {
                console.error('Error ending recognize stream on disconnect:', error);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
