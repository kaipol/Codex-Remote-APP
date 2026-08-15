#!/usr/bin/env bash
# Build web assets and sync to Capacitor (Android/iOS)
# Usage: ./build-app.sh [android|ios]
set -e

PLATFORM="${1:-android}"

echo "==> Building web assets..."
npm run build

echo "==> Syncing to Capacitor..."
npx cap sync "$PLATFORM"

echo "==> Done! Run 'npx cap open $PLATFORM' to open the native project."
echo "==> Build APK: cd android && ./gradlew assembleDebug (requires Android Studio/SDK)"
