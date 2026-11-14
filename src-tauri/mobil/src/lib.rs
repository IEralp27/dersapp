//! Telefon (Android) yerel eklentisi. Kotlin sınıfı: android/src/main/java/MobilPlugin.kt.
//! Uygulamanın Rust komutları `app.state::<Mobil<R>>().call("komut", veri)` ile Kotlin komutlarını çağırır.
//! Android dışında `call` hata döndürür (eklenti yalnızca Android'de bağımlılık olarak eklenir).

use serde::{de::DeserializeOwned, Serialize};
use std::marker::PhantomData;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub struct Mobil<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    _r: PhantomData<fn() -> R>,
}

impl<R: Runtime> Mobil<R> {
    /// Kotlin komutunu çalıştırır, yanıtını `T` olarak döndürür. Hata metni Kotlin'in reject mesajıdır.
    pub async fn call<T: DeserializeOwned>(&self, cmd: &str, payload: impl Serialize) -> Result<T, String> {
        #[cfg(target_os = "android")]
        {
            self.handle.run_mobile_plugin_async(cmd, payload).await.map_err(|e| match e {
                tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r) => {
                    r.message.unwrap_or_else(|| "Telefon işlemi başarısız oldu.".into())
                }
                other => other.to_string(),
            })
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (cmd, payload);
            Err("Bu özellik yalnızca Android'de var.".into())
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mobil")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let m = Mobil {
                handle: api.register_android_plugin("com.eralp.dersapp.mobil", "MobilPlugin")?,
                _r: PhantomData,
            };
            #[cfg(not(target_os = "android"))]
            let m = {
                let _ = api;
                Mobil::<R> { _r: PhantomData }
            };
            app.manage(m);
            Ok(())
        })
        .build()
}
