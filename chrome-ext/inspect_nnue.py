import struct
import sys

def parse_nnue(filename):
    with open(filename, 'rb') as f:
        version = struct.unpack('<I', f.read(4))[0]
        hash_val = struct.unpack('<I', f.read(4))[0]
        desc_len = struct.unpack('<I', f.read(4))[0]
        desc = f.read(desc_len).decode('utf-8')
        print(f"Version: {version}, Hash: {hash_val}, Desc: {desc}")
        
        ft_hash = struct.unpack('<I', f.read(4))[0]
        print(f"FT Hash: {ft_hash}")
        
        # skip FT biases and weights
        f.seek(256 * 2 + 41024 * 256 * 2, 1)
        
        fc_hash = struct.unpack('<I', f.read(4))[0]
        print(f"FC Hash: {fc_hash}")

parse_nnue('c:\\Users\\ygtyg\\OneDrive\\Desktop\\projects\\chess-engine\\chrome-ext\\net.nnue')
