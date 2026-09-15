// Paste the config object from your Firebase project here.
// Firebase Console -> Project settings (gear icon) -> General tab -> "Your apps" -> the web app -> SDK setup and configuration -> Config.
// These values are not secret — they identify your project to Google's servers, the same way a website's URL does.
// What actually protects your data is the Firestore security rules (see firestore.rules and the README).
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
