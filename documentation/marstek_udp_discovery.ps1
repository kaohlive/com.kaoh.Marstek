# Marstek Battery UDP Discovery Script
# Based on official Marstek Device Open API documentation Rev 1.0
# Discovers Marstek devices using the official UDP broadcast protocol

param(
    [int]$TimeoutSeconds = 10,
    [int]$Port = 30000,  # Default port from official documentation
    [string]$BroadcastAddress = "255.255.255.255"
)

function Send-MarstekDiscovery {
    param(
        [string]$BroadcastIP,
        [int]$Port,
        [int]$Timeout
    )
    
    Write-Host "Starting Marstek Device Discovery..." -ForegroundColor Green
    Write-Host "Using Official Marstek UDP Protocol" -ForegroundColor Cyan
    Write-Host "Broadcasting on: ${BroadcastIP}:${Port}" -ForegroundColor Yellow
    Write-Host "Timeout: $Timeout seconds" -ForegroundColor Yellow
    Write-Host "=" * 60
    
    try {
        # Create UDP client
        $udpClient = New-Object System.Net.Sockets.UdpClient
        $udpClient.EnableBroadcast = $true
        $udpClient.Client.ReceiveTimeout = $Timeout * 1000
        
        # Create broadcast endpoint
        $broadcastEndpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($BroadcastIP), $Port)
        
        # Official Marstek discovery message from documentation
        $discoveryMessage = @{
            "id" = 0
            "method" = "Marstek.GetDevice"
            "params" = @{
                "ble_mac" = "0"
            }
        }
        
        # Convert to JSON
        $jsonMessage = $discoveryMessage | ConvertTo-Json -Compress
        Write-Host "Sending official discovery message:" -ForegroundColor Cyan
        Write-Host $jsonMessage -ForegroundColor White
        Write-Host ""
        
        # Convert message to bytes
        $messageBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonMessage)
        
        # Send broadcast message
        $sentBytes = $udpClient.Send($messageBytes, $messageBytes.Length, $broadcastEndpoint)
        Write-Host "Broadcast sent ($sentBytes bytes). Listening for responses..." -ForegroundColor Green
        Write-Host ""
        
        $foundDevices = @()
        $startTime = Get-Date
        
        # Listen for responses
        while (((Get-Date) - $startTime).TotalSeconds -lt $Timeout) {
            try {
                # Create endpoint to receive from any IP
                $remoteEndpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
                $receivedBytes = $udpClient.Receive([ref]$remoteEndpoint)
                
                if ($receivedBytes.Length -gt 0) {
                    $responseText = [System.Text.Encoding]::UTF8.GetString($receivedBytes)
                    
                    Write-Host "MARSTEK DEVICE FOUND!" -ForegroundColor Green -BackgroundColor Black
                    Write-Host "Response from: $($remoteEndpoint.Address):$($remoteEndpoint.Port)" -ForegroundColor Yellow
                    Write-Host "Raw response: $responseText" -ForegroundColor White
                    
                    try {
                        # Parse JSON response
                        $jsonResponse = $responseText | ConvertFrom-Json
                        
                        if ($jsonResponse.result) {
                            $result = $jsonResponse.result
                            
                            Write-Host ""
                            Write-Host "DEVICE DETAILS:" -ForegroundColor Cyan
                            Write-Host "  Device Model: $($result.device)" -ForegroundColor White
                            Write-Host "  Source ID: $($jsonResponse.src)" -ForegroundColor White
                            Write-Host "  IP Address: $($result.ip)" -ForegroundColor White
                            Write-Host "  Firmware Version: $($result.ver)" -ForegroundColor White
                            Write-Host "  Bluetooth MAC: $($result.ble_mac)" -ForegroundColor White
                            Write-Host "  WiFi MAC: $($result.wifi_mac)" -ForegroundColor White
                            Write-Host "  WiFi Network: $($result.wifi_name)" -ForegroundColor White
                            
                            $device = [PSCustomObject]@{
                                DeviceModel = $result.device
                                SourceID = $jsonResponse.src
                                IPAddress = $result.ip
                                RespondingIP = $remoteEndpoint.Address.ToString()
                                Port = $remoteEndpoint.Port
                                FirmwareVersion = $result.ver
                                BluetoothMAC = $result.ble_mac
                                WiFiMAC = $result.wifi_mac
                                WiFiNetwork = $result.wifi_name
                                RawResponse = $responseText
                                Timestamp = Get-Date
                            }
                            
                            $foundDevices += $device
                        }
                        elseif ($jsonResponse.error) {
                            Write-Host ""
                            Write-Host "DEVICE ERROR RESPONSE:" -ForegroundColor Red
                            Write-Host "  Error Code: $($jsonResponse.error.code)" -ForegroundColor White
                            Write-Host "  Error Message: $($jsonResponse.error.message)" -ForegroundColor White
                        }
                    }
                    catch {
                        Write-Host "Could not parse JSON response: $($_.Exception.Message)" -ForegroundColor Red
                        
                        # Still record as found device even if JSON parsing fails
                        $device = [PSCustomObject]@{
                            DeviceModel = "Unknown"
                            SourceID = "Unknown"
                            IPAddress = "Unknown"
                            RespondingIP = $remoteEndpoint.Address.ToString()
                            Port = $remoteEndpoint.Port
                            FirmwareVersion = "Unknown"
                            BluetoothMAC = "Unknown"
                            WiFiMAC = "Unknown"
                            WiFiNetwork = "Unknown"
                            RawResponse = $responseText
                            Timestamp = Get-Date
                        }
                        
                        $foundDevices += $device
                    }
                    
                    Write-Host "=" * 60
                }
            }
            catch [System.Net.Sockets.SocketException] {
                # Timeout - continue listening
                continue
            }
            catch {
                Write-Host "Error receiving data: $($_.Exception.Message)" -ForegroundColor Red
                break
            }
        }
        
        # Summary
        Write-Host ""
        Write-Host "DISCOVERY COMPLETE" -ForegroundColor Green -BackgroundColor Black
        Write-Host "=" * 60
        
        if ($foundDevices.Count -gt 0) {
            Write-Host "Found $($foundDevices.Count) Marstek device(s):" -ForegroundColor Green
            Write-Host ""
            
            $foundDevices | ForEach-Object {
                Write-Host "Device: $($_.DeviceModel) ($($_.SourceID))" -ForegroundColor Yellow
                Write-Host "  IP Address: $($_.IPAddress)" -ForegroundColor White
                Write-Host "  Responding from: $($_.RespondingIP):$($_.Port)" -ForegroundColor White
                Write-Host "  Firmware: v$($_.FirmwareVersion)" -ForegroundColor White
                Write-Host "  WiFi Network: $($_.WiFiNetwork)" -ForegroundColor White
                Write-Host "  Bluetooth MAC: $($_.BluetoothMAC)" -ForegroundColor White
                Write-Host "  WiFi MAC: $($_.WiFiMAC)" -ForegroundColor White
                Write-Host "  Found at: $($_.Timestamp)" -ForegroundColor Gray
                Write-Host ""
            }
            
            # Export results
            $exportPath = "marstek_devices.csv"
            $foundDevices | Export-Csv -Path $exportPath -NoTypeInformation
            Write-Host "Device information exported to: $exportPath" -ForegroundColor Cyan
            
            # Show next steps
            Write-Host ""
            Write-Host "NEXT STEPS:" -ForegroundColor Magenta
            Write-Host "You can now communicate with your Marstek device(s) using:" -ForegroundColor White
            
            $foundDevices | ForEach-Object {
                Write-Host "  Device: $($_.DeviceModel)" -ForegroundColor Yellow
                Write-Host "    IP: $($_.IPAddress)" -ForegroundColor White
                Write-Host "    Port: $Port (configured in Marstek app)" -ForegroundColor White
                Write-Host "    Available APIs: Marstek, WiFi, BLE, Bat, PV, ES, EM" -ForegroundColor Gray
                Write-Host ""
            }
            
        } else {
            Write-Host "No Marstek devices found on the network." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "TROUBLESHOOTING:" -ForegroundColor Cyan
            Write-Host "1. Ensure your Marstek device is connected to the same network" -ForegroundColor White
            Write-Host "2. Enable the Open API feature in the Marstek mobile app" -ForegroundColor White
            Write-Host "3. Check the UDP port number in the app (default: 30000)" -ForegroundColor White
            Write-Host "4. Verify the device is powered on and WiFi is connected" -ForegroundColor White
            Write-Host "5. Check firewall settings aren't blocking UDP traffic" -ForegroundColor White
            Write-Host "6. Try running as Administrator" -ForegroundColor White
            Write-Host ""
            Write-Host "Port range 49152-65535 is recommended per documentation" -ForegroundColor Gray
        }
        
    }
    catch {
        Write-Host "Error during discovery: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Stack trace: $($_.Exception.StackTrace)" -ForegroundColor Red
    }
    finally {
        if ($udpClient) {
            $udpClient.Close()
            $udpClient.Dispose()
        }
    }
}

# Test JSON-RPC communication function
function Test-MarstekAPI {
    param(
        [string]$DeviceIP,
        [int]$Port = 30000
    )
    
    Write-Host ""
    Write-Host "Testing API communication with $DeviceIP..." -ForegroundColor Cyan
    
    try {
        $udpClient = New-Object System.Net.Sockets.UdpClient
        $udpClient.Client.ReceiveTimeout = 5000  # 5 second timeout
        
        $endpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Parse($DeviceIP), $Port)
        
        # Test battery status query
        $testMessage = @{
            "id" = 1
            "method" = "Bat.GetStatus"
            "params" = @{
                "id" = 0
            }
        }
        
        $jsonMessage = $testMessage | ConvertTo-Json -Compress
        $messageBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonMessage)
        
        Write-Host "Sending test command: $jsonMessage" -ForegroundColor White
        $udpClient.Send($messageBytes, $messageBytes.Length, $endpoint) | Out-Null
        
        $remoteEndpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        $receivedBytes = $udpClient.Receive([ref]$remoteEndpoint)
        $responseText = [System.Text.Encoding]::UTF8.GetString($receivedBytes)
        
        Write-Host "Response received: $responseText" -ForegroundColor Green
        
        $jsonResponse = $responseText | ConvertFrom-Json
        if ($jsonResponse.result) {
            Write-Host "API communication successful!" -ForegroundColor Green
            Write-Host "Battery SOC: $($jsonResponse.result.soc)%" -ForegroundColor White
        }
        
    }
    catch {
        Write-Host "API test failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    finally {
        if ($udpClient) {
            $udpClient.Close()
            $udpClient.Dispose()
        }
    }
}

# Main execution
Clear-Host
Write-Host "Marstek Device Discovery Tool" -ForegroundColor Magenta
Write-Host "Based on Official API Documentation Rev 1.0" -ForegroundColor Magenta
Write-Host "=" * 60
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
if (-not $isAdmin) {
    Write-Host "NOTE: Not running as Administrator. Some network operations may be limited." -ForegroundColor Yellow
    Write-Host ""
}

# Show network information
try {
    $networkAdapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" -and ($_.MediaType -eq "802.3" -or $_.MediaType -like "*Wireless*") }
    Write-Host "Active network interfaces:" -ForegroundColor Cyan
    $networkAdapters | ForEach-Object {
        $ipConfig = Get-NetIPAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue
        if ($ipConfig) {
            Write-Host "  $($_.Name): $($ipConfig.IPAddress)" -ForegroundColor White
        }
    }
    Write-Host ""
}
catch {
    Write-Host "Could not enumerate network adapters." -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "IMPORTANT: Ensure the following before discovery:" -ForegroundColor Yellow
Write-Host "1. Marstek device is connected to your WiFi network" -ForegroundColor White
Write-Host "2. Open API is enabled in the Marstek mobile app" -ForegroundColor White
Write-Host "3. UDP port is configured (default: 30000)" -ForegroundColor White
Write-Host ""

# Start discovery
$devices = Send-MarstekDiscovery -BroadcastIP $BroadcastAddress -Port $Port -Timeout $TimeoutSeconds

# Test API if devices found
if ($devices -and $devices.Count -gt 0) {
    Write-Host "Would you like to test API communication? (y/n): " -ForegroundColor Cyan -NoNewline
    $response = Read-Host
    if ($response -eq 'y' -or $response -eq 'Y') {
        $devices | ForEach-Object {
            if ($_.IPAddress -ne "Unknown") {
                Test-MarstekAPI -DeviceIP $_.IPAddress -Port $Port
            }
        }
    }
}

Write-Host ""
Write-Host "Discovery completed. Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")