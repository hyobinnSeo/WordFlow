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

// Serve static files from public directory
app.use(express.static('public'));

// Create speech client and Gemini API client
let client;
let genAI;
try {
    // Set credentials using single API key file
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow.json');
    client = new speech.SpeechClient();
    
    // Initialize Gemini API with the API key
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
        throw new Error('Please set your Gemini API key in the .env file');
    }
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    console.log('Successfully initialized Google Cloud Speech and Gemini API clients');
} catch (error) {
    console.error('Error initializing clients:', error);
}

// Translation function using Gemini API
async function translateText(text) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        
        // Add delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const prompt = `Translate the following English text to Korean. Only provide the translation, no explanations:
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

    socket.on('startGoogleCloudStream', async () => {
        try {
            isStreamActive = true;
            createRecognizeStream();
            console.log('Successfully created recognize stream');

            // Set up total duration limit
            clearTimeout(totalDurationTimeout);
            totalDurationTimeout = setTimeout(() => {
                }
            }, 60000);

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
