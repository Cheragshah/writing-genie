#!/bin/bash
# Double-click this file to start Writing Genie and open it in your browser.
cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules ]; then
  echo "Installing Writing Genie's dependencies…"
  npm install || { echo "Install failed. Check your Node.js setup."; read -r -p "Press return to close."; exit 1; }
fi

( sleep 1.2; open "http://localhost:4173" ) &
npm start
