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

// Detect language and translate text
async function detectAndTranslate(text) {
    try {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-bbc3162e9dd5.json');
        
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
function createRecognizeStream(socket) {
    // Set credentials for Speech-to-Text before starting stream
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-0481bfc9b57e.json');
    
    console.log('Starting new recognize stream...');
    
    const request = {
        config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'ko-KR',  // Set Korean as primary
            alternativeLanguageCodes: ['en-US'],  // Add English as alternative
            enableAutomaticPunctuation: true,
            model: 'default',
            useEnhanced: true,
            metadata: {
                interactionType: 'DICTATION',
                microphoneDistance: 'NEARFIELD',
                recordingDeviceType: 'PC_MIC',
            },
            enableLanguageIdentification: true,  // Enable dynamic language identification
            speechContexts: [{
                phrases: ['한국어', 'English', '영어', 'Korean']  // Add common language-related phrases
            }]
        },
        interimResults: true
    };

    const recognizeStream = client
        .streamingRecognize(request)
        .on('error', (error) => {
            console.error('Error in recognize stream:', error);
            
            // Only emit error if it's not a timeout
            if (!error.message.includes('Audio Timeout Error')) {
                socket.emit('error', 'Speech recognition error occurred: ' + error.message);
            }
            
            // Recreate stream if active and not ending
            if (socket.isStreamActive && !socket.isEnding) {
                console.log('Recreating stream after error...');
                socket.recognizeStream = createRecognizeStream(socket);
            }
        })
        .on('data', async (data) => {
            if (data.results[0] && data.results[0].alternatives[0]) {
                const transcript = data.results[0].alternatives[0].transcript;
                const isFinal = data.results[0].isFinal;
                
                // Send original transcription
                socket.emit('transcription', {
                    text: transcript,
                    isFinal: isFinal,
                    languageCode: data.results[0].languageCode
                });

                // If it's a final result, translate and create new stream
                if (isFinal && socket.isStreamActive && !socket.isEnding) {
                    try {
                        const result = await detectAndTranslate(transcript);
                        socket.emit('translation', {
                            original: transcript,
                            translated: result.translation,
                            fromLang: result.detectedLang,
                            toLang: result.targetLang
                        });
                        
                        // Gracefully end current stream and create new one
                        console.log('Creating new stream after final result...');
                        const currentStream = socket.recognizeStream;
                        socket.recognizeStream = createRecognizeStream(socket);
                        if (currentStream) {
                            currentStream.end();
                        }
                    } catch (error) {
                        socket.emit('error', 'Translation error: ' + error.message);
                    }
                }
            }
        })
        .on('end', () => {
            console.log('Recognize stream ended');
            // Create new stream if still active and not ending
            if (socket.isStreamActive && !socket.isEnding) {
                console.log('Creating new stream after end...');
                socket.recognizeStream = createRecognizeStream(socket);
            }
        });

    return recognizeStream;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.recognizeStream = null;
    socket.isStreamActive = false;
    socket.isEnding = false;

    socket.on('startGoogleCloudStream', async () => {
        try {
            socket.isStreamActive = true;
            socket.isEnding = false;
            socket.recognizeStream = createRecognizeStream(socket);
            console.log('Successfully created recognize stream');
        } catch (error) {
            console.error('Error creating recognize stream:', error);
            socket.emit('error', 'Failed to start speech recognition: ' + error.message);
            socket.isStreamActive = false;
        }
    });

    socket.on('audioData', (data) => {
        // Check if stream exists, is active, and is writable
        if (socket.recognizeStream && socket.isStreamActive && !socket.recognizeStream.destroyed && socket.recognizeStream.writable) {
            try {
                // Convert the ArrayBuffer to Buffer
                const buffer = Buffer.from(data);
                socket.recognizeStream.write(buffer);
            } catch (error) {
                console.error('Error writing to recognize stream:', error);
                if (!error.message.includes('Audio Timeout Error')) {
                    socket.emit('error', 'Error processing audio: ' + error.message);
                }
            }
        }
    });

    socket.on('endGoogleCloudStream', () => {
        if (socket.recognizeStream && socket.isStreamActive) {
            try {
                socket.isEnding = true;  // Prevent stream recreation
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
                socket.isEnding = true;  // Prevent stream recreation
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
