#!/bin/bash
set -e

# Remove Chromium lock files if they exist to prevent "profile in use" errors
echo "Cleaning up Chromium locks..."
rm -f /app/ig-profile/SingletonLock
rm -f /app/ig-profile/SingletonCookie
rm -f /app/ig-profile/SingletonSocket

# Start Xvfb (Virtual Framebuffer)
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1280x1024x24 &
export DISPLAY=:99

# Start a lightweight window manager
echo "Starting Fluxbox..."
fluxbox &

# Start VNC server
echo "Starting x11vnc..."
x11vnc -display :99 -forever -shared -nopw -listen 127.0.0.1 &

# Start noVNC proxy via websockify
echo "Starting noVNC on port 6080..."
websockify --web /usr/share/novnc 6080 127.0.0.1:5900 &

echo "VNC stack is up. Executing application command..."
exec "$@"
