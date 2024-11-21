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

// Translation function
async function translateText(text) {
    try {
        // Reset credentials for Translation before translating
        process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-bbc3162e9dd5.json');
        const [translation] = await translate.translate(text, 'ko');
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

    socket.on('startGoogleCloudStream', async () => {
        try {
            // Set credentials for Speech-to-Text before starting stream
            process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-0481bfc9b57e.json');
            
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

            // Create the stream with detailed logging
            recognizeStream = client
                .streamingRecognize(request)
                .on('error', (error) => {
                    console.error('Error in recognize stream:', error);
                    socket.emit('error', 'Speech recognition error occurred: ' + error.message);
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
                                const translatedText = await translateText(transcript);
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
                });

            console.log('Successfully created recognize stream');
        } catch (error) {
            console.error('Error creating recognize stream:', error);
            socket.emit('error', 'Failed to start speech recognition: ' + error.message);
        }
    });

    socket.on('audioData', (data) => {
        if (recognizeStream && recognizeStream.writable) {
            try {
                // Convert the ArrayBuffer to Buffer
                const buffer = Buffer.from(data);
                recognizeStream.write(buffer);
            } catch (error) {
                console.error('Error writing to recognize stream:', error);
                socket.emit('error', 'Error processing audio: ' + error.message);
            }
        }
    });

    socket.on('endGoogleCloudStream', () => {
        if (recognizeStream) {
            try {
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
        if (recognizeStream) {
            try {
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
