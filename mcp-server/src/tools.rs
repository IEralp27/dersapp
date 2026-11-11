//! Gömülü araç tanımları (`tools.json`).

use serde_json::{Map, Value};
use std::time::Duration;

/// Derleme zamanında gömülen araç dosyası.
pub const TOOLS_JSON: &str = include_str!("../tools.json");

/// Yerleşik (uygulamaya sorulmadan yanıtlanan) aracın adı.
pub const STATUS_TOOL: &str = "dersapp_status";

/// `timeoutSec` verilmezse kullanılan bekleme süresi.
pub const DEFAULT_TIMEOUT_SEC: u64 = 60;

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    /// Uygulamanın yanıtı için en çok bekleme süresi.
    pub timeout: Duration,
    /// `inputSchema.required` listesi (basit ön denetim için).
    pub required: Vec<String>,
    /// `tools/list` ile istemciye gönderilen biçim (iç alanlar ayıklanmış).
    pub public: Value,
}

#[derive(Debug, Clone)]
pub struct ToolSet {
    pub tools: Vec<ToolDef>,
}

impl ToolSet {
    /// Gömülü `tools.json`'u yükler. Dosya bozuksa bu bir derleme hatası
    /// sayılır (birim testleri yakalar), bu yüzden panik.
    pub fn embedded() -> ToolSet {
        match ToolSet::parse(TOOLS_JSON) {
            Ok(t) => t,
            Err(e) => panic!("tools.json geçersiz: {e}"),
        }
    }

    /// `{ "tools": [ ... ] }` ya da doğrudan dizi kabul eder.
    pub fn parse(text: &str) -> Result<ToolSet, String> {
        let root: Value = serde_json::from_str(text).map_err(|e| format!("JSON ayrıştırılamadı: {e}"))?;
        let list = match &root {
            Value::Array(a) => a,
            Value::Object(o) => o
                .get("tools")
                .and_then(Value::as_array)
                .ok_or("kökte \"tools\" dizisi yok")?,
            _ => return Err("kök bir nesne ya da dizi olmalı".into()),
        };

        let mut tools: Vec<ToolDef> = Vec::with_capacity(list.len());
        for (i, raw) in list.iter().enumerate() {
            let obj = raw.as_object().ok_or(format!("{i}. araç bir nesne değil"))?;
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(format!("{i}. aracın \"name\" alanı yok"))?
                .to_string();
            if tools.iter().any(|t| t.name == name) {
                return Err(format!("\"{name}\" adı iki kez tanımlanmış"));
            }
            if obj.get("description").and_then(Value::as_str).unwrap_or("").is_empty() {
                return Err(format!("\"{name}\" için \"description\" boş"));
            }
            let schema = obj
                .get("inputSchema")
                .and_then(Value::as_object)
                .ok_or(format!("\"{name}\" için \"inputSchema\" nesnesi yok"))?;
            if schema.get("type").and_then(Value::as_str) != Some("object") {
                return Err(format!("\"{name}\": inputSchema.type \"object\" olmalı"));
            }
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let timeout_sec = match obj.get("timeoutSec") {
                None => DEFAULT_TIMEOUT_SEC,
                Some(v) => v
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or(format!("\"{name}\": timeoutSec pozitif bir tam sayı olmalı"))?,
            };

            // İstemciye gidecek biçim: iç alanları (timeoutSec, _yorum…) çıkar.
            let mut public = Map::new();
            for (k, v) in obj {
                if k == "timeoutSec" || k.starts_with('_') {
                    continue;
                }
                public.insert(k.clone(), v.clone());
            }

            tools.push(ToolDef {
                name,
                timeout: Duration::from_secs(timeout_sec),
                required,
                public: Value::Object(public),
            });
        }
        Ok(ToolSet { tools })
    }

    pub fn get(&self, name: &str) -> Option<&ToolDef> {
        self.tools.iter().find(|t| t.name == name)
    }

    /// `tools/list` sonucu için araç listesi (dosyadaki sırayla, belirlenimci).
    pub fn list_json(&self) -> Vec<Value> {
        self.tools.iter().map(|t| t.public.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gomulu_tools_json_gecerli() {
        let set = ToolSet::parse(TOOLS_JSON).expect("tools.json ayrıştırılmalı");
        for name in [
            "dersapp_status",
            "list_documents",
            "read_page",
            "read_pages_text",
            "go_to_page",
            "show_test",
            "get_test_results",
            "list_exams",
            "add_exam",
        ] {
            assert!(set.get(name).is_some(), "{name} eksik");
        }
        // İç alanlar dışarı sızmamalı.
        for t in set.list_json() {
            assert!(t.get("timeoutSec").is_none());
            assert!(t.as_object().unwrap().keys().all(|k| !k.starts_with('_')));
        }
        assert_eq!(set.get("read_pages_text").unwrap().timeout, Duration::from_secs(120));
        assert_eq!(set.get("list_exams").unwrap().timeout, Duration::from_secs(DEFAULT_TIMEOUT_SEC));
        assert_eq!(set.get("add_exam").unwrap().required, vec!["course", "date"]);
    }

    #[test]
    fn bozuk_tanimlar_reddedilir() {
        assert!(ToolSet::parse("{").is_err());
        assert!(ToolSet::parse(r#"{"tools":[{"name":"a","description":"x"}]}"#).is_err());
        assert!(ToolSet::parse(
            r#"[{"name":"a","description":"x","inputSchema":{"type":"object"}},
                {"name":"a","description":"y","inputSchema":{"type":"object"}}]"#
        )
        .is_err());
        assert!(ToolSet::parse(
            r#"[{"name":"a","description":"x","inputSchema":{"type":"object"},"timeoutSec":0}]"#
        )
        .is_err());
    }
}
