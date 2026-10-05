import re

with open('chrome-ext/background.js', 'r', encoding='utf-8') as f:
    text = f.read()

text = re.sub(r'timeToThink=\$\{engineTime\}ms', 'my_ms=ms', text)

with open('chrome-ext/background.js', 'w', encoding='utf-8') as f:
    f.write(text)
