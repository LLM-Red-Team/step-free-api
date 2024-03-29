function decimalToPaddedHex(decimal, size) {
  // 创建一个新的Buffer，大小为size个字节
  const buffer = Buffer.alloc(size);

  // 将十进制值写入Buffer，从最后一个字节开始写，即最低有效字节（小端序）
  buffer.writeUInt32BE(decimal, size - 4); // 假设size至少为4

  // 如果需要，可以返回Buffer的十六进制表示
  return buffer.toString('hex');
}

// 使用示例
const decimalValue = 10000000;
const size = 5; // 我们需要一个5字节的Buffer来存储这个值
const hexString = decimalToPaddedHex(decimalValue, size);

console.log(hexString); // 输出: 00 00 00 00 3c
