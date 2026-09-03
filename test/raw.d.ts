// Vite's ?raw suffix imports a file's text. Fixtures are loaded this way so
// the bytes reach the test exactly as they sit on disk — a JSON import would
// parse and reserialise them, which is the one thing a signed envelope cannot
// survive.
declare module '*?raw' {
  const content: string;
  export default content;
}
