fn main() {
    let f: i32 = 0;
    let mask = 0x0101010101010101_u64 << f;
    println!("{}", mask);
}
