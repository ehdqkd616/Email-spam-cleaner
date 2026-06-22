Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "E:\OneDrive\Development\Claude_Code_Project\Email-spam-cleaner"
WshShell.Run "node """ & "E:\OneDrive\Development\Claude_Code_Project\Email-spam-cleaner\electron\launch.js" & """, 0, False