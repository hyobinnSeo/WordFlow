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

// Serve static files from public directory
app.use(express.static('public'));

// Create a speech client with error handling
let client;
try {
    // Set GOOGLE_APPLICATION_CREDENTIALS environment variable
    process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'keys', 'voiceflow-442410-0481bfc9b57e.json');
    
    client = new speech.SpeechClient();
    console.log('Successfully initialized Google Cloud Speech client');
} catch (error) {
    console.error('Error initializing Google Cloud Speech client:', error);
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
                .on('data', (data) => {
                    console.log('Received data from Google Cloud Speech:', JSON.stringify(data, null, 2));
                    if (data.results[0] && data.results[0].alternatives[0]) {
                        const transcription = data.results[0].alternatives[0].transcript;
                        console.log('Sending transcription to client:', transcription);
                        socket.emit('transcription', transcription);
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
                console.log('Received audio data length:', buffer.length);
                
                recognizeStream.write(buffer);
                console.log('Audio data written to stream');
            } catch (error) {
                console.error('Error writing to recognize stream:', error);
                socket.emit('error', 'Error processing audio: ' + error.message);
            }
        } else {
            console.log('Recognize stream not ready or not writable');
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
