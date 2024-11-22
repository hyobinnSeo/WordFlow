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
const path = require('path');

// Serve static files from public directory
app.use(express.static('public'));

// Create speech and translation clients with error handling
let client;
let translate;
try {
    // Set credentials for Speech-to-Text
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-0481bfc9b57e.json');
    client = new speech.SpeechClient();
    
    // Set credentials for Translation
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-bbc3162e9dd5.json');
    translate = new Translate();
    
    console.log('Successfully initialized Google Cloud clients');
} catch (error) {
    console.error('Error initializing Google Cloud clients:', error);
}

// Translation function with direction support
async function translateText(text, isKoreanToEnglish) {
    try {
        // Reset credentials for Translation before translating
        process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-bbc3162e9dd5.json');
        const [translation] = await translate.translate(text, isKoreanToEnglish ? 'en' : 'ko');
        return translation;
    } catch (error) {
        console.error('Translation error:', error);
        throw error;
    }
}

// Basic route for testing
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    let recognizeStream = null;
    let isStreamActive = false;
    let isKoreanToEnglish = true; // Default translation direction

    // Handle translation direction changes
    socket.on('setTranslationDirection', (data) => {
        isKoreanToEnglish = data.isKoreanToEnglish;
        console.log(`Translation direction set to: ${isKoreanToEnglish ? 'Korean → English' : 'English → Korean'}`);
        
        // If there's an active stream, end it so it can be recreated with new language
        if (recognizeStream && isStreamActive) {
            try {
                isStreamActive = false;
                recognizeStream.end();
            } catch (error) {
                console.error('Error ending recognize stream on direction change:', error);
            }
        }
    });

    socket.on('startGoogleCloudStream', async (data) => {
        try {
            // Set credentials for Speech-to-Text before starting stream
            process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-0481bfc9b57e.json');
            
            console.log('Starting new recognize stream...');
            
            const request = {
                config: {
                    encoding: 'LINEAR16',
                    sampleRateHertz: 16000,
                    languageCode: isKoreanToEnglish ? 'ko-KR' : 'en-US',
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

            // Create the stream with detailed logging
            recognizeStream = client
                .streamingRecognize(request)
                .on('error', (error) => {
                    console.error('Error in recognize stream:', error);
                    socket.emit('error', 'Speech recognition error occurred: ' + error.message);
                    isStreamActive = false;
                })
                .on('data', async (data) => {
                    if (data.results[0] && data.results[0].alternatives[0]) {
                        const transcript = data.results[0].alternatives[0].transcript;
                        const isFinal = data.results[0].isFinal;
                        
                        // Send original transcription
                        socket.emit('transcription', {
                            text: transcript,
                            isFinal: isFinal
                        });

                        // If it's a final result, translate and send
                        if (isFinal) {
                            try {
                                const translatedText = await translateText(transcript, isKoreanToEnglish);
                                socket.emit('translation', {
                                    original: transcript,
                                    translated: translatedText
                                });
                            } catch (error) {
                                socket.emit('error', 'Translation error: ' + error.message);
                            }
                        }
                    }
                })
                .on('end', () => {
                    console.log('Recognize stream ended');
                    isStreamActive = false;
                });

            isStreamActive = true;
            console.log('Successfully created recognize stream');
        } catch (error) {
            console.error('Error creating recognize stream:', error);
            socket.emit('error', 'Failed to start speech recognition: ' + error.message);
            isStreamActive = false;
        }
    });

    socket.on('audioData', (data) => {
        // Check if stream exists, is active, and is writable
        if (recognizeStream && isStreamActive && !recognizeStream.destroyed && recognizeStream.writable) {
            try {
                // Convert the ArrayBuffer to Buffer
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
        if (recognizeStream && isStreamActive) {
            try {
                isStreamActive = false;  // Set this first to prevent any new writes
                recognizeStream.end();
                console.log('Successfully ended recognize stream');
            } catch (error) {
                console.error('Error ending recognize stream:', error);
                socket.emit('error', 'Error ending stream: ' + error.message);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        if (recognizeStream && isStreamActive) {
            try {
                isStreamActive = false;
                recognizeStream.end();
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
