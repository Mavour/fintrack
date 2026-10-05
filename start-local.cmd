@echo off
cd /d C:\Users\ASUS\OneDrive\Documents\fintrack
if not exist data mkdir data
node dist\server\index.js >> data\server.log 2>&1
