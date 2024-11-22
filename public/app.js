// Initialize socket connection with explicit configuration
const socket = io({
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

const recordButton = document.getElementById('recordButton');
const autoScrollButton = document.getElementById('autoScrollButton');
const translationModeButton = document.getElementById('translationModeButton');
const transcriptionArea = document.getElementById('transcription');
const translationArea = document.getElementById('secondary-text');

let mediaRecorder;
let audioContext;
let audioInput;
let processor;
let mediaStream;
const bufferSize = 2048;
let finalTranscript = '';
let interimTranscript = '';
let translatedText = '';
let isAutoScrollEnabled = true;
let isRecording = false;
let isKoreanToEnglish = true;

// Debug logging
console.log('Script loaded');

// Auto-scroll toggle functionality
autoScrollButton.addEventListener('click', () => {
    isAutoScrollEnabled = !isAutoScrollEnabled;
    autoScrollButton.textContent = `⟳ Auto-scroll: ${isAutoScrollEnabled ? 'ON' : 'OFF'}`;
});

// Translation mode toggle functionality
translationModeButton.addEventListener('click', async () => {
    isKoreanToEnglish = !isKoreanToEnglish;
    translationModeButton.textContent = isKoreanToEnglish ? '🔄 KO → EN' : '🔄 EN → KO';
    
    // Notify server about translation direction change
    socket.emit('setTranslationDirection', { isKoreanToEnglish });

    // If currently recording, restart the stream with new language
    if (isRecording) {
        // Temporarily store recording state
        const wasRecording = isRecording;
        
        // Stop current stream
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
            await audioContext.close();
            audioContext = null;
        }

        socket.emit('endGoogleCloudStream');
        
        // Small delay to ensure clean transition
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Restart recording if it was active
        if (wasRecording) {
            try {
                await initAudioContext();
                socket.emit('startGoogleCloudStream', { isKoreanToEnglish });
                isRecording = true;
                recordButton.textContent = '⏹ Stop Recording';
                recordButton.classList.add('recording');
            } catch (error) {
                console.error('Error restarting recording:', error);
                alert('Error restarting recording. Please try again.');
                isRecording = false;
                recordButton.textContent = '⏺ Start Recording';
                recordButton.classList.remove('recording');
            }
        }
    }
});

// Function to handle auto-scrolling
function autoScrollTextArea(textarea) {
    if (isAutoScrollEnabled) {
        textarea.scrollTop = textarea.scrollHeight;
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
            
            // Send the buffer with translation direction
            socket.emit('audioData', int16Data.buffer, { isKoreanToEnglish });
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

            socket.emit('startGoogleCloudStream', { isKoreanToEnglish });
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
                await audioContext.close();
                audioContext = null;
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

// Handle connection status
socket.on('connect', () => {
    console.log('Connected to server');
    recordButton.disabled = false;
    // Send initial translation direction on connect
    socket.emit('setTranslationDirection', { isKoreanToEnglish });
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
