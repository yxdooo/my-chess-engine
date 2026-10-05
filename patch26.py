import re

with open('chrome-ext/background.js', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('timeToThink=ms', 'my_ms=ms')

with open('chrome-ext/background.js', 'w', encoding='utf-8') as f:
    f.write(text)
