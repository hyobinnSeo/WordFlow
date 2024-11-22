// Initialize socket connection with explicit configuration
const socket = io({
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

const recordButton = document.getElementById('recordButton');
const autoScrollButton = document.getElementById('autoScrollButton');
const transcriptionArea = document.getElementById('transcription');
const translationArea = document.getElementById('translation');
const copyTranscriptionButton = document.getElementById('copyTranscriptionButton');
const copyTranslationButton = document.getElementById('copyTranslationButton');

let mediaRecorder;
let audioContext;
let audioInput;
let processor;
let mediaStream; // Added to store the media stream
const bufferSize = 2048;
let finalTranscript = '';
let interimTranscript = '';
let translatedText = '';
let isAutoScrollEnabled = true;
let isRecording = false;

// Debug logging
console.log('Script loaded');

// Copy functionality
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('Failed to copy text:', err);
        return false;
    }
}

// Copy button event listeners
copyTranscriptionButton.addEventListener('click', async () => {
    const success = await copyToClipboard(transcriptionArea.value);
    const originalText = copyTranscriptionButton.textContent;
    
    copyTranscriptionButton.textContent = success ? '✓ Copied!' : '❌ Failed to copy';
    setTimeout(() => {
        copyTranscriptionButton.textContent = originalText;
    }, 2000);
});

copyTranslationButton.addEventListener('click', async () => {
    const success = await copyToClipboard(translationArea.value);
    const originalText = copyTranslationButton.textContent;
    
    copyTranslationButton.textContent = success ? '✓ Copied!' : '❌ Failed to copy';
    setTimeout(() => {
        copyTranslationButton.textContent = originalText;
    }, 2000);
});

// Auto-scroll toggle functionality
autoScrollButton.addEventListener('click', () => {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    autoScrollButton.textContent = `Auto-scroll: ${isAutoScrollEnabled ? 'ON' : 'OFF'}`;
});

// Function to handle auto-scrolling
function autoScrollTextArea(textarea) {
    if (isAutoScrollEnabled) {
        textarea.scrollTop = textarea.scrollHeight;
    }
}

// Function to stop recording UI
function stopRecordingUI() {
    if (audioInput && processor) {
        audioInput.disconnect(processor);
        processor.disconnect(audioContext.destination);
    }

    // Stop all tracks in the media stream
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => {
            track.stop();
        });
        mediaStream = null;
    }

    // Reset audio context
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    isRecording = false;
    recordButton.textContent = '⏺ Start Recording';
    recordButton.classList.remove('recording');
    console.log('Stopped recording');
    
    // Add the last interim transcript to final if it exists
    if (interimTranscript) {
        finalTranscript += (finalTranscript ? '\n\n' : '') + interimTranscript;
        interimTranscript = '';
        updateTranscriptionArea();
    }
}

// Initialize audio context
async function initAudioContext() {
    try {
        console.log('Requesting microphone access...');
        mediaStream = await navigator.mediaDevices.getUserMedia({ 
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
        
        audioInput = audioContext.createMediaStreamSource(mediaStream);
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

// Toggle recording
recordButton.addEventListener('click', async () => {
    if (!isRecording) {
        // Start recording
        console.log('Starting recording...');
        try {
            if (!audioContext) {
                await initAudioContext();
            } else if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }
            
            audioInput.connect(processor);
            processor.connect(audioContext.destination);

            socket.emit('startGoogleCloudStream');
            isRecording = true;
            recordButton.textContent = '⏹ Stop Recording';
            recordButton.classList.add('recording');
            console.log('Started recording');
        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Error starting recording. Please try again.');
        }
    } else {
        // Stop recording
        console.log('Stopping recording...');
        try {
            socket.emit('endGoogleCloudStream');
            stopRecordingUI();
        } catch (error) {
            console.error('Error stopping recording:', error);
            alert('Error stopping recording.');
        }
    }
});

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
        // Add to final transcript with two new lines between sentences
        finalTranscript += (finalTranscript ? '\n\n' : '') + data.text;
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
    translatedText += (translatedText ? '\n\n' : '') + data.translated;
    updateTranslationArea();
});

// Handle recording stopped event
socket.on('recordingStopped', (data) => {
    console.log('Recording stopped:', data.reason);
    stopRecordingUI();
    if (data.reason === 'Recording limit of 2 hours reached') {
        alert('Recording automatically stopped after reaching 2-hour limit.');
    }
});

// Handle time remaining notifications
socket.on('timeRemaining', (data) => {
    if (data.minutes <= 5) {
        alert(`Recording will automatically stop in ${data.minutes} minute${data.minutes !== 1 ? 's' : ''}`);
    }
});

// Handle connection status
socket.on('connect', () => {
    console.log('Connected to server');
    recordButton.disabled = false;
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    recordButton.disabled = true;
    isRecording = false;
    recordButton.textContent = '⏺ Start Recording';
    recordButton.classList.remove('recording');
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
