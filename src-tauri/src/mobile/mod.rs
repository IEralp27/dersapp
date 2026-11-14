//! Telefon (Android/iOS) yer tutucuları: masaüstüne özgü modüllerle aynı komut adları,
//! anlaşılır bir Türkçe hata döndürür. Arayüz bu özellikleri telefonda zaten gizler (src/platform.ts).

pub mod piper;
pub mod web;

pub const YOK: &str = "Bu özellik telefonda yok (yalnızca masaüstü uygulamasında).";
