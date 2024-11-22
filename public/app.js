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
const originalLangTag = document.getElementById('originalLang');
const targetLangTag = document.getElementById('targetLang');

let mediaRecorder;
let audioContext;
let audioInput;
let workletNode;
let mediaStream;
let playbackContext;
let finalTranscript = '';
let interimTranscript = '';
let isAutoScrollEnabled = true;
let isRecording = false;

// Language codes to full names mapping
const languageNames = {
    'en': 'English',
    'ko': 'Korean',
    'en-US': 'English',
    'ko-KR': 'Korean'
};

// Debug logging
console.log('Script loaded');

// Initialize playback context for TTS
function initPlaybackContext() {
    if (!playbackContext) {
        playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return playbackContext;
}

// Function to play TTS audio without interrupting input
async function playTTSAudio(base64Audio) {
    try {
        const context = initPlaybackContext();
        
        // Convert base64 to array buffer
        const binaryString = atob(base64Audio);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Decode the audio data
        const audioBuffer = await context.decodeAudioData(bytes.buffer);
        
        // Create and play the audio
        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(context.destination);
        source.start(0);
        
        source.onended = () => {
            source.disconnect();
        };
    } catch (error) {
        console.error('Error playing TTS audio:', error);
    }
}

// Auto-scroll toggle functionality
autoScrollButton.addEventListener('click', () => {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    autoScrollButton.textContent = `⟳ Auto-scroll: ${isAutoScrollEnabled ? 'ON' : 'OFF'}`;
});

// Function to handle auto-scrolling
function autoScrollTextArea(textarea) {
    if (isAutoScrollEnabled) {
        textarea.scrollTop = textarea.scrollHeight;
    }
}

// Initialize audio context with AudioWorklet
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

        // Load and initialize the audio worklet
        await audioContext.audioWorklet.addModule('audioProcessor.js');
        
        audioInput = audioContext.createMediaStreamSource(mediaStream);
        workletNode = new AudioWorkletNode(audioContext, 'audio-processor');

        // Handle audio data from worklet
        workletNode.port.onmessage = (event) => {
            socket.emit('audioData', event.data);
        };

        // Connect the audio graph
        audioInput.connect(workletNode);
        workletNode.connect(audioContext.destination);
        
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
            
            // Initialize playback context if needed
            initPlaybackContext();

            // Reset transcripts and translations
            finalTranscript = '';
            interimTranscript = '';
            transcriptionArea.value = '';
            translationArea.value = '';
            originalLangTag.textContent = 'Detecting...';
            targetLangTag.textContent = 'Waiting...';

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
            if (audioInput && workletNode) {
                audioInput.disconnect();
                workletNode.disconnect();
            }

            // Stop all tracks in the media stream
            if (mediaStream) {
                mediaStream.getTracks().forEach(track => {
                    track.stop();
                });
                mediaStream = null;
            }

            // Close audio contexts
            if (audioContext) {
                await audioContext.close();
                audioContext = null;
            }
            if (playbackContext) {
                await playbackContext.close();
                playbackContext = null;
            }

            socket.emit('endGoogleCloudStream');
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

// Handle transcription updates
socket.on('transcription', (data) => {
    console.log('Received transcription:', data);
    
    if (data.isFinal) {
        finalTranscript += (finalTranscript ? '\n\n' : '') + data.text;
        interimTranscript = '';
    } else {
        interimTranscript = data.text;
    }
    
    // Update language tag if provided
    if (data.languageCode) {
        const langName = languageNames[data.languageCode] || data.languageCode;
        originalLangTag.textContent = langName;
    }
    
    updateTranscriptionArea();
});

// Handle translation updates
socket.on('translation', (data) => {
    console.log('Received translation:', data);
    
    // Update translation text
    translationArea.value += (translationArea.value ? '\n\n' : '') + data.translated;
    autoScrollTextArea(translationArea);
    
    // Update language tags
    if (data.fromLang && data.toLang) {
        originalLangTag.textContent = languageNames[data.fromLang] || data.fromLang;
        targetLangTag.textContent = languageNames[data.toLang] || data.toLang;
    }
});

// Handle TTS audio
socket.on('tts-audio', (base64Audio) => {
    console.log('Received TTS audio, playing...');
    playTTSAudio(base64Audio);
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
