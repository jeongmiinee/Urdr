use eframe::egui;

#[derive(Default)]
struct SmokeApp;

impl eframe::App for SmokeApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ui, |ui| {
            ui.heading("URDR WGPU smoke test");
        });
    }
}

fn main() -> eframe::Result {
    let mut wgpu_options = eframe::WgpuConfiguration::default();
    if let eframe::egui_wgpu::WgpuSetup::CreateNew(setup) = &mut wgpu_options.wgpu_setup {
        setup.instance_descriptor.backends =
            eframe::wgpu::Backends::VULKAN | eframe::wgpu::Backends::GL;
    }
    eframe::run_native(
        "URDR WGPU smoke",
        eframe::NativeOptions {
            renderer: eframe::Renderer::Wgpu,
            wgpu_options,
            ..Default::default()
        },
        Box::new(|_| Ok(Box::<SmokeApp>::default())),
    )
}
