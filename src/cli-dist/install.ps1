# Installs the MiniBox CLI from the server that sent this script:
#   irm <origin>/cli/install.ps1 | iex
# The server fills in its own address below. The binary is checked against the server's sha256 list before it is
# installed. MINIBOX_INSTALL_DIR chooses the folder (default %USERPROFILE%\.local\bin), and that folder is added to your
# user PATH. No administrator rights are needed.

# Returns PATH with Directory appended, unless an entry already names it. Pure, so the tests can call it on any OS.
function Merge-PathEntry {
  param([string]$Path, [Parameter(Mandatory)][string]$Directory)
  $wanted = $Directory.TrimEnd('\')
  $entries = @($Path -split ';' | Where-Object { $_ -ne '' })
  if ($entries | Where-Object { $_.TrimEnd('\') -ieq $wanted }) { return $Path }
  return (@($entries) + $Directory) -join ';'
}

# Adds Directory to the user PATH in the registry, so new terminals find it. The value is read unexpanded and written
# back as ExpandString, so entries such as %USERPROFILE%\bin keep their variables. Returns $true when it changed the
# value, and does nothing off Windows.
function Add-UserPathEntry {
  param([Parameter(Mandatory)][string]$Directory)
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { return $false }
  $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if ($null -eq $environment) { throw 'Your user environment settings cannot be opened, so the PATH was not changed.' }
  try {
    $current = [string]$environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $merged = Merge-PathEntry -Path $current -Directory $Directory
    if ($merged -eq $current) { return $false }
    $environment.SetValue('Path', $merged, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } finally {
    $environment.Close()
  }
  Send-EnvironmentChange
  return $true
}

# Tells running programs, Explorer included, that the user environment changed, so a terminal opened from the Start menu
# sees the new PATH. Setting and clearing a user variable through .NET sends that broadcast without native code.
function Send-EnvironmentChange {
  try {
    [System.Environment]::SetEnvironmentVariable('MINIBOX_INSTALL_REFRESH', '1', 'User')
    [System.Environment]::SetEnvironmentVariable('MINIBOX_INSTALL_REFRESH', $null, 'User')
  } catch {
    # The PATH is already saved; without the broadcast only a new sign-in picks it up.
  }
}

function Install-MiniBoxCli {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $origin = '__MINIBOX_ORIGIN__'
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  if ($architecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw "There is no MiniBox CLI for Windows $architecture yet. Build it from a checkout with bun run build:cli."
  }

  $fileName = 'minibox-windows-x64.exe'
  $dir = if ($env:MINIBOX_INSTALL_DIR) { $env:MINIBOX_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $target = Join-Path $dir 'minibox.exe'
  $download = Join-Path $dir ".minibox-download-$PID.exe"

  try {
    try {
      Invoke-WebRequest -Uri "$origin/cli/$fileName" -OutFile $download -UseBasicParsing | Out-Null
    } catch {
      $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
      throw "Could not download $fileName from ${origin}: $detail"
    }
    $sums = (Invoke-WebRequest -Uri "$origin/cli/checksums.txt" -UseBasicParsing).Content
    $expected = $null
    foreach ($line in ($sums -split "`r?`n")) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Length -eq 2 -and $parts[1] -eq $fileName) { $expected = $parts[0].ToLowerInvariant() }
    }
    if (-not $expected) { throw "The server lists no checksum for $fileName." }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "Checksum mismatch for $fileName (expected $expected, got $actual). Nothing was installed."
    }
    # A running minibox.exe cannot be overwritten, but Windows lets it be renamed, so the old file moves aside first.
    $movedAside = $false
    if (Test-Path -LiteralPath $target) {
      $previous = "$target.old"
      Remove-Item -LiteralPath $previous -Force -ErrorAction SilentlyContinue
      try {
        Move-Item -Force -LiteralPath $target -Destination $previous
        $movedAside = $true
      } catch {
        throw "$target is in use, so it was not replaced. Close the terminals that run minibox, then run this again."
      }
    }
    Move-Item -Force -LiteralPath $download -Destination $target
  } finally {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
  }

  # A binary Windows cannot start throws instead of setting an exit code, and both cases restore the previous file.
  $runs = $false
  try {
    $version = & $target --version
    $runs = $LASTEXITCODE -eq 0
  } catch {
    $runs = $false
  }
  if (-not $runs) {
    if ($movedAside) {
      Move-Item -Force -LiteralPath "$target.old" -Destination $target
      throw "The new $fileName does not run on this machine, so the previous minibox.exe was kept."
    }
    throw "$target was installed, but it does not run on this machine."
  }
  Write-Host "Installed $target ($version)"
  if (Add-UserPathEntry -Directory $dir) {
    Write-Host "Added $dir to your user PATH. Open a new terminal, so minibox and ssh find it."
  }
  $env:Path = Merge-PathEntry -Path $env:Path -Directory $dir
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host 'The OpenSSH client is not installed. Add the "OpenSSH Client" optional feature in Windows Settings.'
  }
  Write-Host ''
  Write-Host 'Set up SSH with an access key, or an agent token that has the box:ssh scope:'
  Write-Host ('  $env:MINIBOX_URL="' + $origin + '"; $env:MINIBOX_ACCESS_KEY="<token>"; minibox ssh-config --append')
}

Install-MiniBoxCli
