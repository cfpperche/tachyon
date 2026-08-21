import * as pdfjs from "pdfjs-dist";

(window as Window & { __tachyonPdfjs?: typeof pdfjs }).__tachyonPdfjs = pdfjs;
