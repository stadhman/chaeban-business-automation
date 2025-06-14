rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper function to check if user is from business domain
    function isBusinessUser() {
      return request.auth != null && 
             request.auth.token.email.matches('.*@chaebanicecream\\.com$');
    }
    
    // Helper function to check if user is admin (includes your dev account)
    function isAdmin() {
      return request.auth != null && (
        request.auth.token.email.matches('.*@chaebanicecream\\.com$') ||
        request.auth.token.email == 'dstewart@ibexpayroll.ca'
      );
    }
    
    // Inventory data access
    match /inventory/{document=**} {
      allow read: if isBusinessUser();
      allow write: if isAdmin();
    }
    
    // System logs and metadata
    match /logs/{document=**} {
      allow read: if isAdmin();
      allow write: if isAdmin();
    }
    
    // User management and config
    match /{collection}/{document} {
      allow read: if isBusinessUser() && collection in ['users', 'config'];
      allow write: if isAdmin() && collection in ['users', 'config'];
    }
    
    // Default deny all other access
    match /{document=**} {
      allow read, write: if false;
    }
  }
}