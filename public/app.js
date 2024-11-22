// Initialize socket connection with explicit configuration
const socket = io({
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

const recordButton = document.getElementById('recordButton');
const autoScrollButton = document.getElementById('autoScrollButton');
const translationModeButton = document.getElementById('translationModeButton');
const englishTextArea = document.getElementById('english-text');
const koreanTextArea = document.getElementById('korean-text');

let mediaRecorder;
let audioContext;
let audioInput;
let processor;
let mediaStream;
const bufferSize = 2048;
let englishText = '';
let koreanText = '';
let interimTranscript = '';
let isAutoScrollEnabled = true;
let isRecording = false;
let isKoreanToEnglish = false; // false means EN→KO, true means KO→EN

// Debug logging
console.log('Script loaded');

// Function to play audio from base64 data
async function playAudio(base64Audio) {
    try {
        // Convert base64 to ArrayBuffer
        const binaryString = window.atob(base64Audio);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Create audio context and buffer
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
        
        // Create and play audio source
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } catch (error) {
        console.error('Error playing audio:', error);
    }
}

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
            
            // Add the last interim transcript if it exists
            if (interimTranscript) {
                if (isKoreanToEnglish) {
                    koreanText += (koreanText ? '\n\n' : '') + interimTranscript;
                } else {
                    englishText += (englishText ? '\n\n' : '') + interimTranscript;
                }
                interimTranscript = '';
                updateTextAreas();
            }
        } catch (error) {
            console.error('Error stopping recording:', error);
            alert('Error stopping recording.');
        }
    }
});

// Update both text areas
function updateTextAreas() {
    englishTextArea.value = englishText + (isKoreanToEnglish && interimTranscript ? '' : interimTranscript);
    koreanTextArea.value = koreanText + (isKoreanToEnglish ? interimTranscript : '');
    autoScrollTextArea(englishTextArea);
    autoScrollTextArea(koreanTextArea);
}

// Handle transcription updates
socket.on('transcription', (data) => {
    console.log('Received transcription:', data);
    
    if (data.isFinal) {
        if (isKoreanToEnglish) {
            koreanText += (koreanText ? '\n\n' : '') + data.text;
        } else {
            englishText += (englishText ? '\n\n' : '') + data.text;
        }
        interimTranscript = '';
    } else {
        interimTranscript = data.text;
    }
    
    updateTextAreas();
});

// Handle translation updates
socket.on('translation', (data) => {
    console.log('Received translation:', data);
    if (isKoreanToEnglish) {
        englishText += (englishText ? '\n\n' : '') + data.translated;
    } else {
        koreanText += (koreanText ? '\n\n' : '') + data.translated;
    }
    updateTextAreas();
});

// Handle TTS audio
socket.on('tts-audio', (audioContent) => {
    console.log('Received TTS audio');
    playAudio(audioContent);
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
