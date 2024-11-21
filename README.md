# VoiceFlow - Real-time Speech-to-Text Application

A real-time speech-to-text application using Google Cloud Speech-to-Text API. This application converts audio input from your microphone into text in real-time, processing one sentence at a time.

## Features

- Real-time speech-to-text conversion
- Clean and intuitive user interface
- Automatic punctuation
- Support for continuous speech recognition

## Prerequisites

- Node.js (v14 or higher)
- npm (Node Package Manager)
- Google Cloud Platform account with Speech-to-Text API enabled
- Google Cloud credentials JSON file

## Setup

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd voiceflow
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Ensure your Google Cloud credentials file is placed in the `keys` directory:
   - The file should be named `voiceflow-(numbers).json`
   - Make sure it has the necessary permissions for the Speech-to-Text API

4. Start the server:
   ```bash
   npm start
   ```

5. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Usage

1. Click the "Start Recording" button to begin speech recognition
2. Speak into your microphone
3. Watch as your speech is converted to text in real-time
4. Click "Stop Recording" when you're finished

## Technical Stack

- Frontend:
  - HTML5
  - CSS3
  - JavaScript (Vanilla)
  - Socket.IO Client

- Backend:
  - Node.js
  - Express.js
  - Socket.IO
  - Google Cloud Speech-to-Text API

## Requirements

- @google-cloud/speech: ^5.6.0
- express: ^4.18.2
- socket.io: ^4.7.2
- dotenv: ^16.3.1

## Browser Requirements

- Modern web browser with WebRTC support
- Microphone access permissions

## Notes

- The application requires microphone permissions to function
- Ensure you have a stable internet connection for optimal performance
- The Google Cloud Speech-to-Text API may incur charges based on usage
