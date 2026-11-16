const titles = [
  ['Pride and Prejudice', 'Jane Austen', '1813', 'english'],
  ['Alice’s Adventures in Wonderland', 'Lewis Carroll', '1865', 'english'],
  ['The Adventures of Sherlock Holmes', 'Arthur Conan Doyle', '1892', 'english'],
  ['红楼梦', '曹雪芹', '1791', 'chinese'],
  ['Walden', 'Henry David Thoreau', '1854', 'english'],
  ['The Time Machine', 'H. G. Wells', '1895', 'english'],
  ['西游记', '吴承恩', '1592', 'chinese'],
  ['A Tale of Two Cities', 'Charles Dickens', '1859', 'english']
];
export function demoBooks(base) {
  return titles.map(([title, author, year, language], i) => ({ id: `/book/${i + 1}/demo`, title, author, year, language, format: i % 3 ? 'EPUB' : 'PDF', size: `${(1.2 + i * .47).toFixed(1)} MB`, url: `${base}/book/${i + 1}/demo` }));
}
