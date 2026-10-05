import re

with open('chrome-ext/background.js', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('timeToThink=ms', 'my_ms=ms')

# Fix callOffscreenEngine calls
call_pattern = r'callOffscreenEngine\(\s*message\.fen,\s*engineTime,\s*elo,\s*workerCount,\s*(true|false),\s*message\.history,\s*hashSize,\s*sendResponse\s*\)'
new_call = r'callOffscreenEngine(message.fen, my_ms, opp_ms, inc_ms, movesToGo, elo, workerCount, \1, message.history, hashSize, sendResponse)'
text = re.sub(call_pattern, new_call, text)

call_pattern2 = r'callOffscreenEngine\(\s*message\.fen,\s*engineTime,\s*elo,\s*workerCount,\s*(true|false),\s*message\.history,\s*hashSize\s*\);'
new_call2 = r'callOffscreenEngine(message.fen, my_ms, opp_ms, inc_ms, movesToGo, elo, workerCount, \1, message.history, hashSize);'
text = re.sub(call_pattern2, new_call2, text)

with open('chrome-ext/background.js', 'w', encoding='utf-8') as f:
    f.write(text)
