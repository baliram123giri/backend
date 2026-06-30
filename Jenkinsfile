pipeline {
    agent any

    environment {
        PROD_BASE = "/var/www/biodata99/astro/backend"
        KEEP_RELEASES = "3"
        APP_NAME = "backend"
    }

    stages {
        stage('Deploy PROD') {
            steps {
                sh '''
                    set -e

                    echo "Starting Deployment for Backend"

                    TS=$(date +%Y%m%d_%H%M%S)
                    RELEASE="$PROD_BASE/releases/$TS"

                    echo "Creating release directory"
                    mkdir -p "$RELEASE"

                    echo "Copying source code"
                    rsync -a \
                        --exclude=node_modules \
                        --exclude=logs \
                        --exclude=.git \
                        --exclude=.env \
                        --exclude=.env.example \
                        --exclude="*.pem" \
                        --exclude="*.key" \
                        ./backend/ "$RELEASE/"

                    cd "$RELEASE"

                    echo "Linking environment file"
                    ln -sfn "$PROD_BASE/.env" .env

                    echo "Cleaning previous modules"
                    rm -rf node_modules

                    echo "Installing dependencies"
                    npm install

                    echo "Pushing database schema to production database"
                    npx prisma db push --accept-data-loss

                    echo "Generating Prisma Client"
                    npx prisma generate

                    echo "Updating current symlink"
                    ln -sfn "$RELEASE" "$PROD_BASE/current"

                    cd "$PROD_BASE/current"

                    echo "Restarting PM2 process system-wide"

                    if sudo pm2 describe "$APP_NAME" > /dev/null 2>&1; then
                        sudo pm2 reload ecosystem.config.js --only "$APP_NAME" --env production --update-env
                    else
                        sudo pm2 start ecosystem.config.js --only "$APP_NAME" --env production
                    fi

                    sudo pm2 save --force

                    echo "Cleaning old releases safely with superuser privileges"

                    cd "$PROD_BASE/releases"

                    ls -dt */ | tail -n +$(($KEEP_RELEASES + 1)) | xargs -r sudo rm -rf

                    echo "Deployment completed successfully"
                '''
            }
        }
    }

    post {
        success {
            echo 'Deployment completed successfully.'
        }

        failure {
            echo 'Deployment failed. Review the logs above.'
        }
    }
}
