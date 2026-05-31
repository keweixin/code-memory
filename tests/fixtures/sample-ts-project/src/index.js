/**
 * Application entry point.
 */
import { AuthService } from './services/AuthService.js';
const authService = new AuthService();
async function main() {
    console.log('Sample TS Project started');
}
main().catch(console.error);
export { AuthService };
