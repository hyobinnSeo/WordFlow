// Initialize socket connection with explicit configuration
const socket = io('http://localhost:3000', {
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const autoScrollButton = document.getElementById('autoScrollButton');
const inputSourceButton = document.getElementById('inputSourceButton');
const transcriptionArea = document.getElementById('transcription');
const translationArea = document.getElementById('secondary-text');

let mediaRecorder;
let audioContext;
let audioInput;
let processor;
const bufferSize = 2048;
let finalTranscript = '';
let interimTranscript = '';
let translatedText = '';
let isAutoScrollEnabled = true;
let isMicrophoneInput = true;

// Debug logging
console.log('Script loaded');

// Auto-scroll toggle functionality
autoScrollButton.addEventListener('click', () => {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    autoScrollButton.textContent = `⟳ Auto-scroll: ${isAutoScrollEnabled ? 'ON' : 'OFF'}`;
});

// Input source toggle functionality
inputSourceButton.addEventListener('click', async () => {
    if (audioContext) {
        // Stop current recording if active
        if (!startButton.disabled) {
            await stopRecording();
        }
        // Clean up existing audio context
        await audioContext.close();
        audioContext = null;
    }
    
    isMicrophoneInput = !isMicrophoneInput;
    inputSourceButton.textContent = `🎤 Input: ${isMicrophoneInput ? 'Microphone' : 'System Sound'}`;
    startButton.disabled = false;
});

// Function to handle auto-scrolling
function autoScrollTextArea(textarea) {
    if (isAutoScrollEnabled) {
        textarea.scrollTop = textarea.scrollHeight;
    }
}

// Initialize audio context for microphone
async function initMicrophoneAudio() {
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
        setupAudioProcessing();
    } catch (err) {
        console.error('Error accessing microphone:', err);
        alert('Error accessing microphone. Please ensure microphone permissions are granted.');
    }
}

// Initialize audio context for system sound
async function initSystemAudio() {
    try {
        console.log('Requesting system audio access...');
        
        // Request both audio and video (screen sharing)
        const stream = await navigator.mediaDevices.getDisplayMedia({ 
            audio: {
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            },
            video: true  // Required for Chrome to show system audio option
        });

        // Check if audio track is present
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) {
            throw new Error('No audio track available. Please ensure you selected "Share system audio" when sharing.');
        }

        // Stop video track as we only need audio
        stream.getVideoTracks().forEach(track => track.stop());
        
        console.log('System audio access granted');
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000,
            latencyHint: 'interactive'
        });
        
        audioInput = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
        setupAudioProcessing();
    } catch (err) {
        console.error('Error accessing system audio:', err);
        if (err.name === 'NotAllowedError') {
            alert('System audio access denied. Please ensure you:\n1. Click "Share" in the screen sharing dialog\n2. Enable "Share system audio" option\n3. Select the window/tab you want to capture audio from');
        } else if (err.name === 'NotReadableError') {
            alert('Could not access system audio. Please ensure no other application is using exclusive audio access.');
        } else {
            alert('Error accessing system audio: ' + err.message + '\nPlease ensure system audio sharing is enabled and try again.');
        }
        // Reset to microphone input
        isMicrophoneInput = true;
        inputSourceButton.textContent = `🎤 Input: Microphone`;
    }
}

// Setup audio processing chain
function setupAudioProcessing() {
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
}

// Start recording
startButton.addEventListener('click', async () => {
    console.log('Start button clicked');
    startButton.disabled = true;
    stopButton.disabled = false;

    try {
        if (!audioContext) {
            if (isMicrophoneInput) {
                await initMicrophoneAudio();
            } else {
                await initSystemAudio();
            }
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
async function stopRecording() {
    console.log('Stopping recording...');
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
}

// Stop recording button handler
stopButton.addEventListener('click', stopRecording);

// Update the transcription area with current transcripts
function updateTranscriptionArea() {
    transcriptionArea.value = finalTranscript + (interimTranscript ? ' ' + interimTranscript : '');
    autoScrollTextArea(transcriptionArea);
}

// Update the translation area with translated text
function updateTranslationArea() {
    translationArea.value = translatedText;
    autoScrollTextArea(translationArea);
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

// Handle translation updates
socket.on('translation', (data) => {
    console.log('Received translation:', data);
    translatedText += (translatedText ? ' ' : '') + data.translated;
    updateTranslationArea();
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
