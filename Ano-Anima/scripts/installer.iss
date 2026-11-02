; 大肥鱼成精 —— 安装包脚本
; 编译：ISCC.exe installer.iss

#define AppName "Ano-Anima"
#define AppVer "1.0.0"
#define AppExe "启动.bat"

[Setup]
AppId={{8E1B7C42-3F5A-4C71-9A2E-6D4B1F0C9A31}
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=Yu-Suki
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\..\Ano-产物\安装包
OutputBaseFilename=Ano-Anima-{#AppVer}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
AllowNoIcons=yes
SetupLogging=yes

[Languages]
Name: "chs"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式"; GroupDescription: "快捷方式："

[Files]
; 整个便携目录原样装进去
Source: "..\..\Ano-产物\便携版\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; 卸载时不要删记忆数据，留一份说明
Source: "..\..\Ano-产物\便携版\README.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "现在启动 {#AppName}"; Flags: postinstall shellexec nowait

[UninstallDelete]
; 程序文件随卸载删除；.data（她的记忆）保留，除非用户勾选
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\prompts"
Type: filesandordirs; Name: "{app}\tools"
Type: files; Name: "{app}\*.md"
Type: files; Name: "{app}\*.json"
Type: files; Name: "{app}\*.bat"
Type: files; Name: "{app}\*.txt"
