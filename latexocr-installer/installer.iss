#define MyAppName "LaTeX OCR"
#define MyAppVersion "1.0.2"
#define MyAppPublisher "GhostForgeLab"
#define MyAppExeName "LaTeX-OCR.exe"

[Setup]
AppId={{2E5652A9-0C0C-49CF-8D7E-64323F915D71}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\LaTeX OCR
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=LaTeX-OCR-Setup-v{#MyAppVersion}-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupLogging=yes

[Files]
Source: "dist\LaTeX-OCR\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "LICENSE-THIRD-PARTY.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autodesktop}\LaTeX OCR"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{group}\LaTeX OCR"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 LaTeX OCR"; Filename: "{uninstallexe}"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 LaTeX OCR"; Flags: nowait postinstall skipifsilent
