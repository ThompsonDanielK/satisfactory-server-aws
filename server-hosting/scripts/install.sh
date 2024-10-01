#!/bin/sh

# Note: Arguments to this script 
#  1: string - S3 bucket for your backup save files (required)
#  2: true|false - whether to use Satisfactory Experimental build (optional, default false)

# Check if S3 bucket is provided
if [ -z "$1" ]; then
    echo "Error: S3 bucket is required."
    exit 1
fi

S3_SAVE_BUCKET=$1
USE_EXPERIMENTAL_BUILD=${2-false}
USE_DUCK_DNS=${3-false}
DOMAIN=$4
TOKEN=$5

# Install steamcmd
add-apt-repository multiverse -y
dpkg --add-architecture i386
apt update

# Needed to accept steam license without hangup
echo steam steam/question 'select' "I AGREE" | sudo debconf-set-selections
echo steam steam/license note '' | sudo debconf-set-selections

apt install -y unzip lib32gcc1 steamcmd

# Install satisfactory
if [ "$USE_EXPERIMENTAL_BUILD" = "true" ]; then
    STEAM_INSTALL_SCRIPT="/usr/games/steamcmd +login anonymous +app_update 1690800 -beta experimental validate +quit"
else
    STEAM_INSTALL_SCRIPT="/usr/games/steamcmd +login anonymous +app_update 1690800 validate +quit"
fi

# Switch to ubuntu user to run steamcmd
su - ubuntu -c "$STEAM_INSTALL_SCRIPT"

# Create systemd service for Satisfactory server
cat << EOF | sudo tee /etc/systemd/system/satisfactory.service
[Unit]
Description=Satisfactory dedicated server
Wants=network-online.target
After=syslog.target network.target nss-lookup.target network-online.target

[Service]
Environment="LD_LIBRARY_PATH=./linux64"
ExecStart=/home/ubuntu/.steam/SteamApps/common/SatisfactoryDedicatedServer/FactoryServer.sh
User=ubuntu
Group=ubuntu
StandardOutput=journal
Restart=on-failure
KillSignal=SIGINT
WorkingDirectory=/home/ubuntu/.steam/SteamApps/common/SatisfactoryDedicatedServer

[Install]
WantedBy=multi-user.target
EOF

# Enable and start the Satisfactory service
sudo systemctl enable satisfactory
sudo systemctl start satisfactory

# Enable auto shutdown
cat << 'EOF' | sudo tee /home/ubuntu/auto-shutdown.sh
#!/bin/sh

shutdownIdleMinutes=10
idleCheckFrequencySeconds=1

isIdle=0
while [ $isIdle -le 0 ]; do
    isIdle=1
    iterations=$((60 / $idleCheckFrequencySeconds * $shutdownIdleMinutes))
    while [ $iterations -gt 0 ]; do
        sleep $idleCheckFrequencySeconds
        connectionBytes=$(ss -lu | grep 777 | awk '{s+=$2} END {print s}')
        if [ ! -z "$connectionBytes" ] && [ "$connectionBytes" -gt 0 ]; then
            isIdle=0
        fi
        if [ $isIdle -le 0 ] && [ $((iterations % 21)) -eq 0 ]; then
           echo "Activity detected, resetting shutdown timer to $shutdownIdleMinutes minutes."
           break
        fi
        iterations=$((iterations - 1))
    done
done

echo "No activity detected for $shutdownIdleMinutes minutes, shutting down."
sudo shutdown -h now
EOF

# Make auto-shutdown script executable
sudo chmod +x /home/ubuntu/auto-shutdown.sh
sudo chown ubuntu:ubuntu /home/ubuntu/auto-shutdown.sh

# Create systemd service for auto shutdown
cat << 'EOF' | sudo tee /etc/systemd/system/auto-shutdown.service
[Unit]
Description=Auto shutdown if no one is playing Satisfactory
After=syslog.target network.target nss-lookup.target network-online.target

[Service]
ExecStart=/home/ubuntu/auto-shutdown.sh
User=ubuntu
Group=ubuntu
StandardOutput=journal
Restart=on-failure
KillSignal=SIGINT
WorkingDirectory=/home/ubuntu

[Install]
WantedBy=multi-user.target
EOF

# Enable and start the auto shutdown service
sudo systemctl enable auto-shutdown
sudo systemctl start auto-shutdown

if [ "$USE_DUCK_DNS" = "true" ]; then
# Create DuckDNS update script
cat << EOF | sudo tee /home/ubuntu/duckdns-update.sh
#!/bin/sh
curl "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}"
EOF

# Make the DuckDNS script executable
sudo chmod +x /home/ubuntu/duckdns-update.sh
sudo chown ubuntu:ubuntu /home/ubuntu/duckdns-update.sh

# Create systemd service for DuckDNS update
cat << 'EOF' | sudo tee /etc/systemd/system/duckdns-update.service
[Unit]
Description=DuckDNS update service
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/home/ubuntu/duckdns-update.sh
User=ubuntu
Group=ubuntu
StandardOutput=journal
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

# Enable and start the DuckDNS update service
sudo systemctl enable duckdns-update
sudo systemctl start duckdns-update
fi


su - ubuntu -c "/usr/local/bin/aws s3 sync s3://$S3_SAVE_BUCKET /home/ubuntu/.config/Epic/FactoryGame/Saved/SaveGames/server"

# Automated backups to S3 every 5 minutes
# Check for existing crontab, add entry for S3 backup
su - ubuntu -c " (crontab -l 2>/dev/null; echo \"*/5 * * * * /usr/local/bin/aws s3 sync /home/ubuntu/.config/Epic/FactoryGame/Saved/SaveGames/server s3://$S3_SAVE_BUCKET\") | crontab -"

echo "Setup completed successfully."
