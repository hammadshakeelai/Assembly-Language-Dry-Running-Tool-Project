Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\Program Files (x86)\DOSBox-0.74-3\DOSBox.exe"" -conf ""C:\Users\HP\Documents\GitHub\assembly-lowlevel\Assembly Language Dry Running Tool Project\afd-toolchain\run_afd.conf""", 1, False
WScript.Sleep 600
WshShell.AppActivate "DOSBox"
