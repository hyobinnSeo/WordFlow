// Initialize socket connection with explicit configuration
const socket = io({
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const transcriptionArea = document.getElementById('transcription');

let mediaRecorder;
let audioContext;
let audioInput;
let processor;
const bufferSize = 2048;
let finalTranscript = '';
let interimTranscript = '';

// Debug logging
console.log('Script loaded');

// Initialize audio context
async function initAudioContext() {
    try {
        console.log('Requesting microphone access...');
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });
        console.log('Microphone access granted');
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000,
            latencyHint: 'interactive'
        });
        
        audioInput = audioContext.createMediaStreamSource(stream);
        processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

        processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            
            // Convert Float32Array to Int16Array
            const int16Data = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                // Convert float to int16
                const s = Math.max(-1, Math.min(1, inputData[i]));
                int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            
            // Send the buffer
            socket.emit('audioData', int16Data.buffer);
        };

        audioInput.connect(processor);
        processor.connect(audioContext.destination);
        console.log('Audio context initialized with sample rate:', audioContext.sampleRate);
    } catch (err) {
        console.error('Error accessing microphone:', err);
        alert('Error accessing microphone. Please ensure microphone permissions are granted.');
    }
}

// Start recording
startButton.addEventListener('click', async () => {
    console.log('Start button clicked');
    startButton.disabled = true;
    stopButton.disabled = false;

    try {
        if (!audioContext) {
            await initAudioContext();
        } else if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        audioInput.connect(processor);
        processor.connect(audioContext.destination);

        socket.emit('startGoogleCloudStream');
        console.log('Started recording');
    } catch (error) {
        console.error('Error starting recording:', error);
        alert('Error starting recording. Please try again.');
        startButton.disabled = false;
        stopButton.disabled = true;
    }
});

// Stop recording
stopButton.addEventListener('click', () => {
    console.log('Stop button clicked');
    startButton.disabled = false;
    stopButton.disabled = true;

    try {
        if (audioInput && processor) {
            audioInput.disconnect(processor);
            processor.disconnect(audioContext.destination);
        }

        socket.emit('endGoogleCloudStream');
        console.log('Stopped recording');
        
        // Add the last interim transcript to final if it exists
        if (interimTranscript) {
            finalTranscript += (finalTranscript ? ' ' : '') + interimTranscript;
            interimTranscript = '';
            updateTranscriptionArea();
        }
    } catch (error) {
        console.error('Error stopping recording:', error);
        alert('Error stopping recording.');
    }
});

// Update the transcription area with current transcripts
function updateTranscriptionArea() {
    transcriptionArea.value = finalTranscript + (interimTranscript ? ' ' + interimTranscript : '');
}

// Handle transcription updates
socket.on('transcription', (data) => {
    console.log('Received transcription:', data);
    
    if (data.isFinal) {
        // Add to final transcript with proper spacing
        finalTranscript += (finalTranscript ? ' ' : '') + data.text;
        interimTranscript = '';
    } else {
        // Update interim transcript
        interimTranscript = data.text;
    }
    
    updateTranscriptionArea();
});

// Handle connection status
socket.on('connect', () => {
    console.log('Connected to server');
    startButton.disabled = false;
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    startButton.disabled = true;
    stopButton.disabled = true;
});

// Handle errors
socket.on('error', (error) => {
    console.error('Server error:', error);
    alert('An error occurred: ' + error);
});

// Handle connection errors
socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
});
